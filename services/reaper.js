'use strict';

const { query } = require('../db/pool');
const provisioner = require('./provisioner');

/**
 * Session reaping (BACKEND.md section 5). A device can vanish without calling
 * /sessions/close, so we periodically remove peers whose last handshake is
 * older than the TTL, freeing their tunnel IP.
 *
 * WireGuard exposes `latest handshake` per peer; node agents report it via
 * /internal/.../report, populating peers.last_handshake_at. Peers that never
 * handshook (agent-less / mock nodes) are reaped by created_at age instead.
 */

const TTL_MINUTES = Number(process.env.PEER_TTL_MINUTES || 30);

async function reapStalePeers() {
  const { rows } = await query(
    `SELECT p.*, s.provisioner, s.agent_url, s.id AS server_id
       FROM peers p JOIN servers s ON s.id = p.server_id
      WHERE p.active
        AND COALESCE(p.last_handshake_at, p.created_at) < now() - ($1 || ' minutes')::interval`,
    [String(TTL_MINUTES)],
  );

  let reaped = 0;
  for (const row of rows) {
    const server = { id: row.server_id, provisioner: row.provisioner, agent_url: row.agent_url };
    try {
      await provisioner.removePeer({ server, publicKey: row.public_key });
    } catch (err) {
      console.error(`[reaper] removePeer failed (${row.server_id}):`, err.message);
      continue; // leave it for the next pass rather than freeing the IP prematurely
    }
    await query('DELETE FROM peers WHERE id = $1', [row.id]);
    reaped += 1;
  }
  if (reaped) console.log(`[reaper] removed ${reaped} stale peer(s)`);
  return reaped;
}

/** Start the periodic reaper. Returns the interval handle. */
function startReaper() {
  const everyMs = Number(process.env.REAPER_INTERVAL_MS || 5 * 60 * 1000);
  const handle = setInterval(() => {
    reapStalePeers().catch((err) => console.error('[reaper] pass failed:', err.message));
  }, everyMs);
  handle.unref?.();
  console.log(`[reaper] started — TTL ${TTL_MINUTES}m, every ${Math.round(everyMs / 1000)}s`);
  return handle;
}

module.exports = { reapStalePeers, startReaper };
