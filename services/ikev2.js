'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');
const provisioner = require('./provisioner');

/**
 * IKEv2 session lifecycle (used by routes/sessions.js). Each connect mints a
 * short-lived EAP-MSCHAPv2 credential,
 * provisions it onto the node's RADIUS, and records an `ikev2_sessions` row. The
 * credential TTL is the connect-gate (docs/IKEV2-MIGRATION.md §6).
 */

// How long a freshly minted EAP credential is accepted for a NEW connection.
// This is the connect-gate window: a Settings-initiated reconnect after it
// lapses reuses a stale credential and is rejected.
//
// NOTE (design decision — see docs/IKEV2-MIGRATION.md §6 + open question):
// strongSwan IKE reauth re-runs EAP mid-session, so this must be >= the longest
// a session should survive UNLESS the node is configured with `reauth=no` (then
// it only gates the initial connect and can be short). Default 24h is a safe
// middle ground; tighten once reauth=no is confirmed on the nodes.
const CRED_TTL_SECONDS = Number(process.env.IKEV2_CRED_TTL_SECONDS || 24 * 60 * 60);

/** Generate a unique-enough EAP username + a strong password. */
function generateCredentials() {
  const username = `u_${crypto.randomBytes(12).toString('hex')}`; // 24 hex chars
  const password = crypto.randomBytes(24).toString('base64url');
  return { username, password };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Create an IKEv2 session for a device on a server: insert the row, provision
 * the credential on the node, and return what the client needs to connect.
 * Rolls back the row if the node can't be programmed, so no orphan credential
 * is left behind.
 *
 * @param {object} args
 * @param {object} args.device          device row
 * @param {object} args.server          server row (provisioner 'ikev2' | 'mock')
 * @param {number|null} args.remainingBytes  device's remaining allowance (null=unlimited)
 * @returns {Promise<{ session: object, eap: {username,password}, expiresAt: Date }>}
 */
async function createSession({ device, server, remainingBytes }) {
  const { username, password } = generateCredentials();
  const expiresAt = new Date(Date.now() + CRED_TTL_SECONDS * 1000);

  const { rows } = await query(
    `INSERT INTO ikev2_sessions (device_id, server_id, eap_username, eap_password_hash, expires_at, active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [device.id, server.id, username, hashPassword(password), expiresAt],
  );
  const session = rows[0];

  try {
    await provisioner.addCredential({ server, username, password, remainingBytes, expiresAt });
  } catch (err) {
    // Roll back the row so we don't leak an un-provisioned credential.
    await query('DELETE FROM ikev2_sessions WHERE id = $1', [session.id]).catch(() => {});
    throw err;
  }

  return { session, eap: { username, password }, expiresAt };
}

/**
 * Revoke one IKEv2 session by username (teardown / close). Removes the RADIUS
 * credential (CoA-disconnecting any live SA) and deletes the row. Best-effort on
 * the node call — the row is removed regardless so the IP/credential frees up.
 */
async function revokeByUsername({ server, username }) {
  try {
    await provisioner.removeCredential({ server, username });
  } catch (err) {
    console.error(`[ikev2] removeCredential failed (${server.id} ${username}): ${err.message}`);
  }
  await query('DELETE FROM ikev2_sessions WHERE server_id = $1 AND eap_username = $2', [
    server.id,
    username,
  ]);
}

/**
 * Build the client-facing connect payload for an IKEv2 session. The app feeds
 * these straight into NEVPNProtocolIKEv2 (iOS) / Ikev2VpnProfile (Android).
 */
function toClientPayload({ server, eap, expiresAt, quota }) {
  return {
    protocol: 'ikev2',
    server: {
      // IKEv2 uses the HOST only (UDP 500/4500); no :port.
      host: server.endpoint,
      remoteID: server.ike_remote_id || server.endpoint,
      caCert: server.ca_cert || null, // null => client must already trust it (bundled)
    },
    eap: { username: eap.username, password: eap.password },
    dns: server.dns,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    quota,
  };
}

module.exports = {
  CRED_TTL_SECONDS,
  generateCredentials,
  hashPassword,
  createSession,
  revokeByUsername,
  toClientPayload,
};
