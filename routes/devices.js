'use strict';

const express = require('express');
const {
  registerDevice,
  signDeviceToken,
  setPremium,
  setQuotaOverride,
  getById,
} = require('../services/devices');
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

/**
 * POST /v1/devices/quota — dev-only override of this device's monthly data
 * allowance, so a developer can force a specific cap (e.g. 100 MB) and exercise
 * the near-cap / exhausted quota UI without burning real data. Same gating as
 * /premium: a device bearer token AND membership in DEV_UNLIMITED_DEVICE_IDS,
 * so it's safe to leave enabled in production (404s when the allowlist is empty).
 * Body: { limitBytes?: number | null }  — a non-negative byte cap, or null to
 *   clear the override and fall back to the plan.
 * Returns: { quota }
 */
router.post(
  '/quota',
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

    const raw = req.body ? req.body.limitBytes : undefined;
    let limitBytes;
    if (raw === null) {
      limitBytes = null; // explicit null clears the override
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      limitBytes = Math.round(raw);
    } else {
      return res
        .status(400)
        .json({ error: 'limitBytes must be a non-negative number or null' });
    }

    const device = (await setQuotaOverride(req.device.id, limitBytes)) || current;
    const quota = await quotaFor(device);
    return res.json({ quota });
  }),
);

/**
 * POST /v1/devices/subscription — grant (or clear) this device's premium
 * entitlement after an App Store purchase/restore. Per product decision we do
 * NOT validate the receipt server-side (the client already verifies it with
 * Apple); the device self-declares its subscription state over its own bearer
 * token, so a device can only change ITS OWN entitlement.
 *
 * Body: { active?: boolean }  (defaults to true)
 * Returns: { isPremium, quota }
 */
router.post(
  '/subscription',
  asyncHandler(async (req, res) => {
    if (!req.device || !req.device.id) {
      return res.status(401).json({ error: 'Device token required' });
    }

    const active =
      req.body && typeof req.body.active === 'boolean' ? req.body.active : true;

    const current = await getById(req.device.id);
    if (!current) return res.status(404).json({ error: 'Unknown device' });

    const device = (await setPremium(req.device.id, active)) || current;
    const quota = await quotaFor(device);
    return res.json({ isPremium: device.is_premium, quota });
  }),
);

module.exports = router;
