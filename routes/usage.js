'use strict';

const express = require('express');
const { getById } = require('../services/devices');
const { quotaFor } = require('../services/quota');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

/**
 * GET /v1/usage — remaining data allowance for the calling device. Returns the
 * same `quota` shape as POST /v1/sessions.
 *
 * The device is identified by `Authorization: Bearer <deviceToken>` (issued by
 * POST /v1/devices). A missing or stale token is a 401 so the client
 * re-registers.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const device = req.device && req.device.id ? await getById(req.device.id) : null;
    if (!device) return res.status(401).json({ error: 'Device token required' });

    return res.json(await quotaFor(device));
  }),
);

module.exports = router;
