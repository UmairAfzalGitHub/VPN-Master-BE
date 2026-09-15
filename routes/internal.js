'use strict';

const express = require('express');
const { pool, query } = require('../db/pool');
const { asyncHandler } = require('../middleware/asyncHandler');
const { addUsage, quotaFor, isExhausted } = require('../services/quota');

const router = express.Router();

const NODE_AGENT_SECRET = process.env.NODE_AGENT_SECRET || '';

/** Guard: node agents authenticate with X-Node-Secret (not the app key). */
function requireNodeSecret(req, res, next) {
  if (!NODE_AGENT_SECRET) {
    return res.status(503).json({ error: 'Node reporting not configured (NODE_AGENT_SECRET unset)' });
  }
  if (req.get('X-Node-Secret') !== NODE_AGENT_SECRET) {
    return res.status(401).json({ error: 'Bad node secret' });
  }
  return next();
}

/**
 * POST /internal/nodes/:serverId/report — a node agent reports per-peer
 * cumulative transfer counters (from `wg show wg0 transfer`) and latest
 * handshakes. We accumulate DELTAS into each device's monthly counter,
 * tolerant of counter resets (peer re-add / reboot), then tell the agent which
 * peers to cut for having hit their allowance (BACKEND.md 6.1 & 6.3).
 *
 * Body: { peers: [{ publicKey, rx, tx, latestHandshake? }] }
 * Returns: { remove: [publicKey, ...] }  // devices now over quota
 */
router.post(
  '/nodes/:serverId/report',
  requireNodeSecret,
  asyncHandler(async (req, res) => {
    const { serverId } = req.params;
    const peers = Array.isArray(req.body && req.body.peers) ? req.body.peers : [];
    const remove = [];

    const client = await pool.connect();
    try {
      for (const p of peers) {
        if (!p || !p.publicKey) continue;
        const rx = Number(p.rx) || 0;
        const tx = Number(p.tx) || 0;

        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT * FROM peers WHERE server_id = $1 AND public_key = $2 FOR UPDATE',
          [serverId, p.publicKey],
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          continue;
        }
        const peer = rows[0];

        // Delta since last sample. If the raw counter went backwards the peer
        // was re-added / node rebooted, so the new reading IS the delta.
        const prevRx = Number(peer.last_sample_rx);
        const prevTx = Number(peer.last_sample_tx);
        const dRx = rx >= prevRx ? rx - prevRx : rx;
        const dTx = tx >= prevTx ? tx - prevTx : tx;
        const delta = dRx + dTx;

        await addUsage(peer.device_id, delta, client);
        await client.query(
          `UPDATE peers SET last_sample_rx = $1, last_sample_tx = $2,
             last_handshake_at = COALESCE($3, last_handshake_at), updated_at = now()
           WHERE id = $4`,
          [rx, tx, p.latestHandshake ? new Date(p.latestHandshake) : null, peer.id],
        );
        await client.query('COMMIT');

        // Recompute quota; if exhausted, ask the agent to drop the peer.
        const dev = await getDevice(peer.device_id);
        if (dev) {
          const quota = await quotaFor(dev);
          if (isExhausted(quota)) remove.push(p.publicKey);
        }
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ remove });
  }),
);

async function getDevice(id) {
  const { rows } = await query('SELECT * FROM devices WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = router;
