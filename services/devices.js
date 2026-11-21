'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

/**
 * Anonymous device identity. No email/login — just enough to attribute quota
 * and (later) premium entitlement to a device without breaking the app's
 * "no account, no logs" promise.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const TOKEN_TTL = process.env.DEVICE_TOKEN_TTL || '365d';

/** Sign a device bearer token. */
function signDeviceToken(device) {
  return jwt.sign({ sub: device.id, kind: 'device' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Verify a device bearer token; returns payload or throws. */
function verifyDeviceToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Fetch a device row by internal uuid. */
async function getById(id) {
  const { rows } = await query('SELECT * FROM devices WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Register (or re-register) a device by its client-supplied deviceId. Returns
 * the device row. Idempotent on device_id.
 * @param {{ deviceId?: string, platform?: string, appVersion?: string }} input
 */
async function registerDevice({ deviceId, platform, appVersion }) {
  if (deviceId) {
    const { rows } = await query(
      `INSERT INTO devices (device_id, platform, app_version, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (device_id)
       DO UPDATE SET platform = COALESCE(EXCLUDED.platform, devices.platform),
                     app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
                     last_seen_at = now()
       RETURNING *`,
      [deviceId, platform || null, appVersion || null],
    );
    return rows[0];
  }
  // No stable id supplied — mint an anonymous device.
  const { rows } = await query(
    `INSERT INTO devices (platform, app_version, last_seen_at)
     VALUES ($1, $2, now()) RETURNING *`,
    [platform || null, appVersion || null],
  );
  return rows[0];
}

/** Touch last_seen_at. */
async function touch(id) {
  await query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [id]);
}

/**
 * Set (or clear) a device's premium entitlement. Used by the dev-only
 * "unlimited data" toggle; clears any expiry so premium is open-ended while on.
 * Returns the updated device row, or null if the id is unknown.
 * @param {string} id
 * @param {boolean} enabled
 */
async function setPremium(id, enabled) {
  const { rows } = await query(
    'UPDATE devices SET is_premium = $2, premium_expires_at = NULL WHERE id = $1 RETURNING *',
    [id, !!enabled],
  );
  return rows[0] || null;
}

/**
 * Set (or clear) a device's dev-only data-allowance override. `bytes` is a
 * non-negative monthly cap in bytes, or null to clear the override and fall
 * back to the plan. Returns the updated device row, or null if the id is
 * unknown.
 * @param {string} id
 * @param {number|null} bytes
 */
async function setQuotaOverride(id, bytes) {
  const value = bytes == null ? null : Math.max(0, Math.round(Number(bytes)));
  const { rows } = await query(
    'UPDATE devices SET quota_override_bytes = $2 WHERE id = $1 RETURNING *',
    [id, value],
  );
  return rows[0] || null;
}

module.exports = {
  JWT_SECRET,
  signDeviceToken,
  verifyDeviceToken,
  getById,
  registerDevice,
  touch,
  setPremium,
  setQuotaOverride,
};
