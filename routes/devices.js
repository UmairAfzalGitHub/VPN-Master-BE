'use strict';

const express = require('express');
const { registerDevice, signDeviceToken } = require('../services/devices');
const { asyncHandler } = require('../middleware/asyncHandler');

const TOKEN_TTL_DAYS = Number(process.env.DEVICE_TOKEN_TTL_DAYS || 365);

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

module.exports = router;
