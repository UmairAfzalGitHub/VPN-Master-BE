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

  reaped += await reapUnauthorizedPeers();
  reaped += await reapIkev2Sessions();
  return reaped;
}

/**
 * Reap IKEv2 sessions. A session is removed when its credential has expired
 * (the connect-gate window lapsed) or it's gone stale (no accounting activity
 * within the TTL). We revoke the credential on the node (best-effort — this
 * also CoA-disconnects any lingering SA) and drop the row, freeing the identity.
 */
async function reapIkev2Sessions() {
  const { rows } = await query(
    `SELECT i.id, i.eap_username, s.id AS server_id, s.provisioner, s.agent_url, s.protocol
       FROM ikev2_sessions i JOIN servers s ON s.id = i.server_id
      WHERE i.revoked = true
         OR i.expires_at < now()
         OR COALESCE(i.last_handshake_at, i.created_at) < now() - ($1 || ' minutes')::interval`,
    [String(TTL_MINUTES)],
  );

  let reaped = 0;
  for (const row of rows) {
    const server = {
      id: row.server_id,
      provisioner: row.provisioner,
      agent_url: row.agent_url,
      protocol: row.protocol,
    };
    try {
      await provisioner.removeCredential({ server, username: row.eap_username });
    } catch (err) {
      console.error(`[reaper] removeCredential failed (${row.server_id}):`, err.message);
      // fall through — still drop the row; an expired credential is already
      // useless, and the node's own expiry/accounting will catch leftovers.
    }
    await query('DELETE FROM ikev2_sessions WHERE id = $1', [row.id]);
    reaped += 1;
  }
  if (reaped) console.log(`[reaper] removed ${reaped} IKEv2 session(s)`);
  return reaped;
}

/**
 * Remove gated reservations that were never authorized: a peer sits un-armed
 * with an expired grant. It was never programmed onto the node, so there's
 * nothing to remove there — we just free the reserved tunnel IP. Legacy peers
 * are always armed and so are never matched here.
 */
async function reapUnauthorizedPeers() {
  const { rowCount } = await query(
    `DELETE FROM peers WHERE NOT armed AND grant_expires_at IS NOT NULL AND grant_expires_at < now()`,
  );
  if (rowCount) console.log(`[reaper] removed ${rowCount} un-authorized reservation(s)`);
  return rowCount;
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

module.exports = { reapStalePeers, reapIkev2Sessions, startReaper };
