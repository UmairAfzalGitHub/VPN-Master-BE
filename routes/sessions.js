'use strict';

const express = require('express');
const { query } = require('../db/pool');
const { asyncHandler } = require('../middleware/asyncHandler');
const { getById, touch } = require('../services/devices');
const { quotaFor, isExhausted } = require('../services/quota');
const ikev2 = require('../services/ikev2');

const router = express.Router();

/** An enabled server by id, or null. */
async function getServer(id) {
  const { rows } = await query('SELECT * FROM servers WHERE id = $1 AND enabled = true', [id]);
  return rows[0] || null;
}

/** Bytes remaining for a device, or null if unlimited (premium). */
function remainingFromQuota(quota) {
  return quota.unlimited ? null : quota.remainingBytes;
}

/** Premium entitlement check (honors an optional expiry). */
function isPremium(device) {
  if (!device || !device.is_premium) return false;
  if (!device.premium_expires_at) return true;
  return new Date(device.premium_expires_at).getTime() > Date.now();
}

/**
 * The calling device, from its bearer token, or null. A device identity is
 * mandatory for sessions: quota is metered per device, so a request with no
 * (or a stale) token must not be allowed to mint a fresh anonymous device —
 * that would hand out a new allowance on every call.
 */
async function deviceFromToken(req) {
  if (!req.device || !req.device.id) return null;
  return getById(req.device.id);
}

/**
 * POST /v1/sessions — open an IKEv2 session on a server. Body: { serverID }.
 *
 * Mints a short-lived EAP-MSCHAPv2 credential, provisions it on the node's
 * RADIUS (armed with the device's REMAINING bytes) and returns the IKEv2
 * coordinates the app feeds into NEVPNProtocolIKEv2 (iOS) / Ikev2VpnProfile
 * (Android). The credential TTL is the connect-gate; there is no client key.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { serverID } = req.body || {};
    if (!serverID) {
      return res.status(400).json({ error: 'serverID is required' });
    }

    const device = await deviceFromToken(req);
    if (!device) return res.status(401).json({ error: 'Device token required' });

    const server = await getServer(serverID);
    if (!server) return res.status(404).json({ error: `Unknown server: ${serverID}` });

    await touch(device.id);

    // Premium gate.
    if (server.is_premium && !isPremium(device)) {
      return res.status(403).json({ error: 'This server requires Premium.' });
    }

    // Quota gate — refuse BEFORE minting a credential if exhausted.
    const quota = await quotaFor(device);
    if (isExhausted(quota)) {
      return res.status(403).json({ error: 'Monthly data limit reached.', quota });
    }

    try {
      const { eap, expiresAt } = await ikev2.createSession({
        device,
        server,
        remainingBytes: remainingFromQuota(quota),
      });
      return res.json(ikev2.toClientPayload({ server, eap, expiresAt, quota }));
    } catch (err) {
      console.error(
        `[sessions] createSession failed for ${serverID} (agent_url=${server.agent_url}): ` +
          `${err.message}` +
          `${err.code ? ` code=${err.code}` : ''}` +
          `${err.cause ? ` cause=${err.cause.code || err.cause.message}` : ''}`,
      );
      return res
        .status(502)
        .json({ error: 'Could not reach the VPN node. Try again or pick another server.' });
    }
  }),
);

/**
 * POST /v1/sessions/close — teardown. Body: { serverID, username }, where
 * `username` is the EAP username handed out at connect. Revokes the credential
 * (the node CoA-disconnects any live session) and drops the session row.
 *
 * Idempotent and ownership-checked: it only acts on a session that belongs to
 * the calling device, and answers 204 either way so it leaks nothing about
 * other devices' sessions.
 */
router.post(
  '/close',
  asyncHandler(async (req, res) => {
    const { serverID, username } = req.body || {};
    if (!serverID || !username) {
      return res.status(400).json({ error: 'serverID and username are required' });
    }

    const device = await deviceFromToken(req);
    if (!device) return res.status(401).json({ error: 'Device token required' });

    // Look the server up regardless of `enabled`: a node that was disabled
    // after the session was minted still needs its credential revoked.
    const { rows: serverRows } = await query('SELECT * FROM servers WHERE id = $1', [serverID]);
    const server = serverRows[0];
    if (!server) return res.status(204).end();

    const { rows: owned } = await query(
      'SELECT 1 FROM ikev2_sessions WHERE server_id = $1 AND eap_username = $2 AND device_id = $3',
      [serverID, username, device.id],
    );
    if (owned.length) {
      await ikev2.revokeByUsername({ server, username });
    }
    return res.status(204).end();
  }),
);

module.exports = router;
