'use strict';

const { pool, query } = require('../db/pool');
const { addUsage, quotaFor, isExhausted } = require('./quota');
const provisioner = require('./provisioner');
const { getById } = require('./devices');
const ikev2 = require('./ikev2');

/**
 * Usage poller. Node agents expose a PULL endpoint (`GET /accounting`, the
 * node's FreeRADIUS accounting), so the control plane periodically polls each
 * agent-backed node, computes per-session RX+TX deltas, and accumulates them
 * into each device's monthly counter — the ledger. It also refreshes
 * ikev2_sessions.last_handshake_at, which drives reaping (services/reaper.js).
 *
 * Delta accounting is tolerant of counter resets (node reboot / accounting
 * restart): if the raw counter went backwards, the new reading IS the delta.
 *
 * Postgres is the ledger; the NODE enforces the cap promptly (its own sweep
 * drops a credential at its remainingBytes). This poller is the backstop: it
 * revokes a device's credentials once the ledger shows it exhausted.
 */

const NODE_AGENT_SECRET = process.env.NODE_AGENT_SECRET || '';
const INTERVAL_MS = Number(process.env.USAGE_POLL_INTERVAL_MS || 60 * 1000);

/**
 * Ingest one node's RADIUS accounting into the ledger, keyed on
 * `ikev2_sessions.eap_username`. Returns the number of sessions processed.
 */
async function ingestServer(server) {
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
      console.error(`[usage] ${server.id} ${String(s.username)}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // Quota ENFORCEMENT backstop: once the ledger shows a device exhausted, revoke
  // its credential (which CoA-disconnects the live session). The node's own
  // sweep normally gets there first; enforcement latency here is one poll.
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
        console.log(`[usage] ${server.id} revoked ${r.eap_username} — quota exhausted`);
      }
    } catch (err) {
      console.error(`[usage] ${server.id} enforce (${deviceId}): ${err.message}`);
    }
  }

  return processed;
}

/** One poll pass over all enabled agent-backed nodes. */
async function pollOnce() {
  const { rows: servers } = await query(
    "SELECT * FROM servers WHERE enabled = true AND provisioner = 'ikev2' AND agent_url IS NOT NULL",
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
