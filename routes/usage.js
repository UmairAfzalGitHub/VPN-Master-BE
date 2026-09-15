'use strict';

const express = require('express');
const { query } = require('../db/pool');
const { getById } = require('../services/devices');
const { quotaFor } = require('../services/quota');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

/**
 * GET /v1/usage — remaining data allowance for the calling device
 * (BACKEND.md 2.5). Returns the same `quota` shape as /sessions.
 *
 * Device identity, in priority order:
 *   1. Authorization: Bearer <deviceToken>  (req.device, preferred)
 *   2. ?deviceId=<clientDeviceId>
 *   3. ?publicKey=<wgPublicKey>  (matches the most recent peer)
 *
 * (2)/(3) exist so the meter works before the client adopts device tokens.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    let device = null;

    if (req.device && req.device.id) {
      device = await getById(req.device.id);
    } else if (req.query.deviceId) {
      const { rows } = await query('SELECT * FROM devices WHERE device_id = $1', [req.query.deviceId]);
      device = rows[0] || null;
    } else if (req.query.publicKey) {
      const { rows } = await query(
        `SELECT d.* FROM devices d JOIN peers p ON p.device_id = d.id
         WHERE p.public_key = $1 ORDER BY p.updated_at DESC LIMIT 1`,
        [req.query.publicKey],
      );
      device = rows[0] || null;
    }

    if (!device) {
      return res.status(404).json({ error: 'Unknown device. Pass a device token, ?deviceId, or ?publicKey.' });
    }

    const quota = await quotaFor(device);
    return res.json(quota);
  }),
);

module.exports = router;
