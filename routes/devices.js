'use strict';

const express = require('express');
const { registerDevice, signDeviceToken, setPremium, getById } = require('../services/devices');
const { quotaFor } = require('../services/quota');
const { asyncHandler } = require('../middleware/asyncHandler');

const TOKEN_TTL_DAYS = Number(process.env.DEVICE_TOKEN_TTL_DAYS || 365);
/**
 * Dev-only "unlimited data" switch. OFF unless ALLOW_DEV_UNLIMITED=true, so it
 * can never be reached in production (the endpoint 404s like it doesn't exist).
 * Only ever enable this in dev/staging.
 */
const ALLOW_DEV_UNLIMITED = String(process.env.ALLOW_DEV_UNLIMITED).toLowerCase() === 'true';

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
 * (the caller can only change ITS OWN device). Gated by ALLOW_DEV_UNLIMITED so
 * production returns 404.
 * Body: { enabled?: boolean }  (defaults to true)
 * Returns: { isPremium, quota }
 */
router.post(
  '/premium',
  asyncHandler(async (req, res) => {
    if (!ALLOW_DEV_UNLIMITED) return res.status(404).json({ error: 'Not found' });
    if (!req.device || !req.device.id) {
      return res.status(401).json({ error: 'Device token required' });
    }
    const enabled =
      req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : true;

    let device = await setPremium(req.device.id, enabled);
    if (!device) {
      // Token valid but the row is gone (e.g. reset DB) — nothing to update.
      device = await getById(req.device.id);
      if (!device) return res.status(404).json({ error: 'Unknown device' });
    }
    const quota = await quotaFor(device);
    return res.json({ isPremium: device.is_premium, quota });
  }),
);

module.exports = router;
