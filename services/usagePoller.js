'use strict';

const { pool, query } = require('../db/pool');
const { addUsage } = require('./quota');

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-Agent-Secret': NODE_AGENT_SECRET },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`metrics ${server.id} -> ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.peers) ? body.peers : [];
  } finally {
    clearTimeout(timer);
  }
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

/** One poll pass over all enabled agent-backed nodes. */
async function pollOnce() {
  const { rows: servers } = await query(
    "SELECT * FROM servers WHERE enabled = true AND provisioner = 'agent' AND agent_url IS NOT NULL",
  );
  for (const server of servers) {
    try {
      await ingestServer(server);
    } catch (err) {
      console.error(`[usage] poll ${server.id} failed: ${err.message}`);
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

module.exports = { pollOnce, ingestServer, startUsagePoller };
