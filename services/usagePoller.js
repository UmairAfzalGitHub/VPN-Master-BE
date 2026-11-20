'use strict';

const { pool, query } = require('../db/pool');
const { addUsage, quotaFor, isExhausted } = require('./quota');
const { requestJson } = require('./provisioner/nodeHttp');
const provisioner = require('./provisioner');
const { getById } = require('./devices');
const ikev2 = require('./ikev2');

/**
 * Usage poller. Our node agents expose a PULL endpoint (`GET /metrics`) rather
 * than pushing, so the control plane periodically polls each agent-backed node,
 * computes per-peer RX+TX deltas, and accumulates them into each device's
 * monthly counter (the ledger — BACKEND.md 6.1). It also refreshes
 * peers.last_handshake_at, which drives stale-peer reaping (services/reaper.js).
 *
 * Delta accounting is tolerant of counter resets (peer re-add / node reboot):
 * if the raw counter went backwards, the new reading IS the delta.
 */

const NODE_AGENT_SECRET = process.env.NODE_AGENT_SECRET || '';
const TIMEOUT_MS = Number(process.env.NODE_AGENT_TIMEOUT_MS || 8000);
const INTERVAL_MS = Number(process.env.USAGE_POLL_INTERVAL_MS || 60 * 1000);

async function fetchMetrics(server) {
  const url = `${server.agent_url.replace(/\/$/, '')}/metrics`;
  const res = await requestJson(url, {
    headers: { 'X-Agent-Secret': NODE_AGENT_SECRET },
    timeoutMs: TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`metrics ${server.id} -> ${res.status}`);
  return res.data && Array.isArray(res.data.peers) ? res.data.peers : [];
}

/** Ingest one agent's metrics into the ledger. Returns peers processed. */
async function ingestServer(server) {
  const peers = await fetchMetrics(server);
  let processed = 0;

  for (const m of peers) {
    if (!m || !m.publicKey) continue;
    const rx = Number(m.rxBytes) || 0;
    const tx = Number(m.txBytes) || 0;
    const handshake = Number(m.lastHandshake) || 0; // unix seconds, 0 = never

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM peers WHERE server_id = $1 AND public_key = $2 FOR UPDATE',
        [server.id, m.publicKey],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        continue; // a peer we didn't allocate (e.g. a test key) — ignore
      }
      const peer = rows[0];
      const prevRx = Number(peer.last_sample_rx);
      const prevTx = Number(peer.last_sample_tx);
      const dRx = rx >= prevRx ? rx - prevRx : rx;
      const dTx = tx >= prevTx ? tx - prevTx : tx;

      await addUsage(peer.device_id, dRx + dTx, client);
      await client.query(
        `UPDATE peers SET last_sample_rx = $1, last_sample_tx = $2,
           last_handshake_at = CASE WHEN $3 > 0 THEN to_timestamp($3) ELSE last_handshake_at END,
           updated_at = now()
         WHERE id = $4`,
        [rx, tx, handshake, peer.id],
      );
      await client.query('COMMIT');
      processed += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[usage] ${server.id} peer ${String(m.publicKey).slice(0, 12)}…: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return processed;
}

/**
 * Ingest one IKEv2 node's RADIUS accounting into the ledger. Mirrors
 * ingestServer but keyed on `ikev2_sessions.eap_username` instead of a peer
 * public key, and sourced from the node agent's /accounting endpoint.
 */
async function ingestIkev2Server(server) {
  const sessions = await provisioner.fetchAccounting({ server });
  let processed = 0;
  const touchedDeviceIds = new Set();

  for (const s of sessions) {
    if (!s || !s.username) continue;
    const rx = Number(s.rxBytes) || 0;
    const tx = Number(s.txBytes) || 0;
    const lastSeen = Number(s.lastSeen) || 0; // unix seconds, 0 = unknown

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM ikev2_sessions WHERE server_id = $1 AND eap_username = $2 FOR UPDATE',
        [server.id, s.username],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        continue; // accounting for a session we didn't mint — ignore
      }
      const sess = rows[0];
      const prevRx = Number(sess.last_sample_rx);
      const prevTx = Number(sess.last_sample_tx);
      const dRx = rx >= prevRx ? rx - prevRx : rx;
      const dTx = tx >= prevTx ? tx - prevTx : tx;

      await addUsage(sess.device_id, dRx + dTx, client);
      await client.query(
        `UPDATE ikev2_sessions SET last_sample_rx = $1, last_sample_tx = $2,
           assigned_ip = COALESCE($3, assigned_ip),
           last_handshake_at = CASE WHEN $4 > 0 THEN to_timestamp($4) ELSE last_handshake_at END,
           updated_at = now()
         WHERE id = $5`,
        [rx, tx, s.assignedIp || null, lastSeen, sess.id],
      );
      await client.query('COMMIT');
      touchedDeviceIds.add(sess.device_id);
      processed += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[usage] ${server.id} ikev2 ${String(s.username)}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // Quota ENFORCEMENT for IKEv2 (plan option 1). WireGuard drops over-quota
  // peers in-kernel; IKEv2 has no such cutoff, so once the ledger shows a
  // device exhausted we revoke its credential here (which CoA-disconnects the
  // live SA). Enforcement latency = one poll interval.
  for (const deviceId of touchedDeviceIds) {
    try {
      const device = await getById(deviceId);
      if (!device) continue;
      if (!isExhausted(await quotaFor(device))) continue;
      const { rows } = await query(
        'SELECT eap_username FROM ikev2_sessions WHERE device_id = $1 AND server_id = $2 AND active',
        [deviceId, server.id],
      );
      for (const r of rows) {
        await ikev2.revokeByUsername({ server, username: r.eap_username });
        console.log(`[usage] ${server.id} revoked ikev2 ${r.eap_username} — quota exhausted`);
      }
    } catch (err) {
      console.error(`[usage] ${server.id} ikev2 enforce (${deviceId}): ${err.message}`);
    }
  }

  return processed;
}

/** One poll pass over all enabled agent-backed nodes (WireGuard + IKEv2). */
async function pollOnce() {
  const { rows: wgServers } = await query(
    "SELECT * FROM servers WHERE enabled = true AND provisioner = 'agent' AND agent_url IS NOT NULL",
  );
  for (const server of wgServers) {
    try {
      await ingestServer(server);
    } catch (err) {
      console.error(`[usage] poll ${server.id} failed: ${err.message}`);
    }
  }

  const { rows: ikev2Servers } = await query(
    "SELECT * FROM servers WHERE enabled = true AND provisioner = 'ikev2' AND agent_url IS NOT NULL",
  );
  for (const server of ikev2Servers) {
    try {
      await ingestIkev2Server(server);
    } catch (err) {
      console.error(`[usage] poll ${server.id} (ikev2) failed: ${err.message}`);
    }
  }
}

/** Start the periodic poller. No-op-safe if no agent nodes exist yet. */
function startUsagePoller() {
  if (!NODE_AGENT_SECRET) {
    console.warn('[usage] NODE_AGENT_SECRET unset — usage poller disabled.');
    return null;
  }
  const handle = setInterval(() => {
    pollOnce().catch((err) => console.error('[usage] pass failed:', err.message));
  }, INTERVAL_MS);
  handle.unref?.();
  console.log(`[usage] poller started — every ${Math.round(INTERVAL_MS / 1000)}s`);
  return handle;
}

module.exports = { pollOnce, ingestServer, ingestIkev2Server, startUsagePoller };
