'use strict';

const { query } = require('../db/pool');
const provisioner = require('./provisioner');

/**
 * Session reaping. A device can vanish without calling /sessions/close (app
 * killed, phone off, network lost), so we periodically remove IKEv2 sessions
 * that are no longer useful, freeing their credential and row.
 *
 * A session is reaped when:
 *   - its credential has expired (the connect-gate window lapsed), or
 *   - it's gone stale: no accounting activity within the TTL. strongSwan sends
 *     RADIUS interim updates (accounting_interval), which the usage poller turns
 *     into ikev2_sessions.last_handshake_at; sessions that never reported are
 *     aged by created_at instead.
 *
 * We revoke the credential on the node (best-effort — this also CoA-disconnects
 * any lingering session) and drop the row. An expired credential is already
 * useless, and the node's own expiry/accounting sweep catches leftovers.
 */

const TTL_MINUTES = Number(process.env.PEER_TTL_MINUTES || 30);

async function reapSessions() {
  const { rows } = await query(
    `SELECT i.id, i.eap_username, s.id AS server_id, s.provisioner, s.agent_url
       FROM ikev2_sessions i JOIN servers s ON s.id = i.server_id
      WHERE i.revoked = true
         OR i.expires_at < now()
         OR COALESCE(i.last_handshake_at, i.created_at) < now() - ($1 || ' minutes')::interval`,
    [String(TTL_MINUTES)],
  );

  let reaped = 0;
  for (const row of rows) {
    const server = { id: row.server_id, provisioner: row.provisioner, agent_url: row.agent_url };
    try {
      await provisioner.removeCredential({ server, username: row.eap_username });
    } catch (err) {
      console.error(`[reaper] removeCredential failed (${row.server_id}):`, err.message);
      // fall through — still drop the row (see above)
    }
    await query('DELETE FROM ikev2_sessions WHERE id = $1', [row.id]);
    reaped += 1;
  }
  if (reaped) console.log(`[reaper] removed ${reaped} session(s)`);
  return reaped;
}

/** Start the periodic reaper. Returns the interval handle. */
function startReaper() {
  const everyMs = Number(process.env.REAPER_INTERVAL_MS || 5 * 60 * 1000);
  const handle = setInterval(() => {
    reapSessions().catch((err) => console.error('[reaper] pass failed:', err.message));
  }, everyMs);
  handle.unref?.();
  console.log(`[reaper] started — TTL ${TTL_MINUTES}m, every ${Math.round(everyMs / 1000)}s`);
  return handle;
}

module.exports = { reapSessions, startReaper };
