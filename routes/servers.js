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
    // The node HOSTNAME (IKE uses UDP 500/4500, so no port). Catalog metadata
    // only; the app gets the connect coordinates from POST /v1/sessions.
    endpoint: row.endpoint,
    // Legacy field from the WireGuard days (the server's public key). Existing
    // client builds still decode it as a REQUIRED string, so keep sending it
    // (always empty) until they drop it.
    publicKey: '',
    load: row.load == null ? null : Number(row.load),
    isPremium: row.is_premium,
    // A server is connectable only when it's backed by a real node agent.
    // Placeholder/seed servers (provisioner='mock') report false so the client
    // can show them as "Coming soon" instead of letting the user connect.
    available: row.enabled && row.provisioner === 'ikev2' && !!row.agent_url,
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
