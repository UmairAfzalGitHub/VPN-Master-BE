'use strict';

const crypto = require('crypto');
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
 * Resolve the device behind a /sessions or /usage call, in priority order:
 *   1. a valid `Authorization: Bearer <deviceToken>` (req.device, set by
 *      middleware) — the correct, spoof-resistant path;
 *   2. an existing peer that already uses this WireGuard public key;
 *   3. otherwise lazily create a new anonymous device keyed to this pubkey.
 *
 * (2)/(3) keep TODAY's client working (it sends only serverID + publicKey and
 * no token yet). Adopting device tokens — BACKEND.md section 2.4 — closes the
 * "new keypair = fresh quota" gap.
 *
 * @param {object} req      express request (may carry req.device)
 * @param {string} publicKey  the client wg public key from the body
 */
async function resolveForSession(req, publicKey) {
  if (req.device && req.device.id) {
    const d = await getById(req.device.id);
    if (d) return d;
  }

  const existing = await query(
    'SELECT d.* FROM devices d JOIN peers p ON p.device_id = d.id WHERE p.public_key = $1 LIMIT 1',
    [publicKey],
  );
  if (existing.rows.length) return existing.rows[0];

  return registerDevice({});
}

/** 32 random bytes, base64 — a valid WireGuard preshared key. */
function generatePresharedKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = {
  JWT_SECRET,
  signDeviceToken,
  verifyDeviceToken,
  getById,
  registerDevice,
  touch,
  resolveForSession,
  generatePresharedKey,
};
