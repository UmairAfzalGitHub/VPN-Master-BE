'use strict';

const express = require('express');
const { query } = require('../db/pool');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

/** Map a DB row to the client's `VPNServer` shape (bare body, Option A). */
function toClient(row) {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    countryCode: row.country_code,
    city: row.city || null,
    endpoint: row.endpoint,
    publicKey: row.public_key,
    load: row.load == null ? null : Number(row.load),
    isPremium: row.is_premium,
    // A server is connectable only when it's backed by a real node agent.
    // Placeholder/seed servers (provisioner='mock') report false so the client
    // can show them as "Coming soon" instead of letting the user connect.
    available: row.enabled && row.provisioner === 'agent' && !!row.agent_url,
  };
}

/**
 * GET /v1/servers — server catalog.
 * Optional ?tier=free|premium filter; default returns all enabled servers.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { tier } = req.query;
    let sql = 'SELECT * FROM servers WHERE enabled = true';
    const params = [];
    if (tier === 'free') sql += ' AND is_premium = false';
    else if (tier === 'premium') sql += ' AND is_premium = true';
    sql += ' ORDER BY COALESCE(load, 1), country, name';

    const { rows } = await query(sql, params);
    res.json(rows.map(toClient));
  }),
);

module.exports = router;
module.exports.toClient = toClient;
