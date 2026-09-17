'use strict';

const express = require('express');
const { registerDevice, signDeviceToken, setPremium, getById } = require('../services/devices');
const { quotaFor } = require('../services/quota');
const { asyncHandler } = require('../middleware/asyncHandler');

const TOKEN_TTL_DAYS = Number(process.env.DEVICE_TOKEN_TTL_DAYS || 365);

/**
 * Dev-only "unlimited data" allowlist. A comma-separated set of client
 * `device_id`s (the stable id the app prints on launch). The /premium endpoint
 * only honors a call whose device is in this set — so it's safe to leave set in
 * production: no other user's device can self-grant premium, and when the list
 * is empty the endpoint 404s like it doesn't exist.
 */
function devUnlimitedDeviceIds() {
  return new Set(
    String(process.env.DEV_UNLIMITED_DEVICE_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const router = express.Router();

/**
 * POST /v1/devices — anonymous device identity + bearer token (BACKEND.md 2.4).
 * Body: { deviceId?, platform?, appVersion? }
 * Returns: { token, expiresAt }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { deviceId, platform, appVersion } = req.body || {};
    const device = await registerDevice({ deviceId, platform, appVersion });
    const token = signDeviceToken(device);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    res.status(201).json({ token, expiresAt });
  }),
);

/**
 * POST /v1/devices/premium — dev-only toggle that grants (or revokes) this
 * device's premium/unlimited-data entitlement. Requires a device bearer token
 * (the caller can only change ITS OWN device) AND the caller's client device_id
 * must be listed in DEV_UNLIMITED_DEVICE_IDS. Any other device — or an empty
 * allowlist — gets a 404/403, so this is safe to leave enabled in production.
 * Body: { enabled?: boolean }  (defaults to true)
 * Returns: { isPremium, quota }
 */
router.post(
  '/premium',
  asyncHandler(async (req, res) => {
    const allowlist = devUnlimitedDeviceIds();
    // Empty allowlist ⇒ feature off; hide the endpoint entirely.
    if (allowlist.size === 0) return res.status(404).json({ error: 'Not found' });

    if (!req.device || !req.device.id) {
      return res.status(401).json({ error: 'Device token required' });
    }

    const current = await getById(req.device.id);
    if (!current) return res.status(404).json({ error: 'Unknown device' });

    // Only allowlisted devices (by their client device_id) may flip this.
    if (!current.device_id || !allowlist.has(current.device_id)) {
      return res.status(403).json({ error: 'Not permitted for this device' });
    }

    const enabled =
      req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : true;

    const device = (await setPremium(req.device.id, enabled)) || current;
    const quota = await quotaFor(device);
    return res.json({ isPremium: device.is_premium, quota });
  }),
);

module.exports = router;
