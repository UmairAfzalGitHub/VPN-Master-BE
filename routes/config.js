'use strict';

const express = require('express');
const { remoteConfig } = require('../services/config');

const router = express.Router();

/** GET /v1/config — remote config + plan definitions (BACKEND.md 2.7). */
router.get('/', (_req, res) => {
  res.json(remoteConfig());
});

module.exports = router;
