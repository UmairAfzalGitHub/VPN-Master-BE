'use strict';

const express = require('express');
const { pool, query } = require('../db/pool');
const { asyncHandler } = require('../middleware/asyncHandler');
const { resolveForSession, generatePresharedKey, touch } = require('../services/devices');
const { quotaFor, isExhausted } = require('../services/quota');
const { allocateAddress } = require('../utils/ip');
const provisioner = require('../services/provisioner');

const router = express.Router();

const USE_PSK = String(process.env.ENABLE_PSK).toLowerCase() !== 'false'; // on by default

async function getServer(id) {
  const { rows } = await query('SELECT * FROM servers WHERE id = $1 AND enabled = true', [id]);
  return rows[0] || null;
}

/** Bytes remaining for a device, or null if unlimited (premium). */
function remainingFromQuota(quota) {
  return quota.unlimited ? null : quota.remainingBytes;
}

/**
 * POST /v1/sessions — register the device pubkey as a peer and negotiate the
 * tunnel (BACKEND.md 2.2). Body: { serverID, publicKey }.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { serverID, publicKey } = req.body || {};
    if (!serverID || !publicKey) {
      return res.status(400).json({ error: 'serverID and publicKey are required' });
    }

    const server = await getServer(serverID);
    if (!server) return res.status(404).json({ error: `Unknown server: ${serverID}` });

    const device = await resolveForSession(req, publicKey);
    await touch(device.id);

    // Premium gate.
    if (server.is_premium && !isPremium(device)) {
      return res.status(403).json({ error: 'This server requires Premium.' });
    }

    // Quota gate — reject BEFORE registering a peer if exhausted.
    const quota = await quotaFor(device);
    if (isExhausted(quota)) {
      return res.status(403).json({ error: 'Monthly data limit reached.', quota });
    }

    // Idempotency: reuse an existing active peer for this (server, pubkey).
    const existing = await query(
      'SELECT * FROM peers WHERE server_id = $1 AND public_key = $2',
      [serverID, publicKey],
    );

    let peer;
    let freshlyAllocated = false;
    if (existing.rows.length) {
      peer = existing.rows[0];
      if (!peer.active) {
        await query('UPDATE peers SET active = true, updated_at = now() WHERE id = $1', [peer.id]);
      }
    } else {
      peer = await allocatePeer({ server, device, publicKey });
      if (!peer) {
        return res.status(503).json({ error: 'Server at capacity, try another region.' });
      }
      freshlyAllocated = true;
    }

    // Program the node (mock or real agent). Arm enforcement with REMAINING
    // bytes, not the full plan. If the node can't be programmed, don't leave a
    // half-registered peer / leaked tunnel IP behind — roll back a fresh
    // allocation and surface a clear error.
    try {
      await provisioner.addPeer({
        server,
        publicKey,
        assignedIp: peer.assigned_ip,
        presharedKey: peer.preshared_key,
        remainingBytes: remainingFromQuota(quota),
      });
    } catch (err) {
      console.error(`[sessions] provisioner.addPeer failed for ${serverID}:`, err.message);
      if (freshlyAllocated) {
        await query('DELETE FROM peers WHERE id = $1', [peer.id]).catch(() => {});
      }
      return res.status(502).json({ error: 'Could not reach the VPN node. Try again or pick another server.' });
    }

    return res.json({
      serverPublicKey: server.public_key,
      endpoint: server.endpoint,
      assignedAddresses: [`${peer.assigned_ip}/32`],
      dns: server.dns,
      presharedKey: peer.preshared_key || null,
      quota,
    });
  }),
);

/**
 * POST /v1/sessions/close — teardown (BACKEND.md 2.3).
 * Body: { serverID, publicKey }. Removes the peer and frees the tunnel IP.
 */
router.post(
  '/close',
  asyncHandler(async (req, res) => {
    const { serverID, publicKey } = req.body || {};
    if (!serverID || !publicKey) {
      return res.status(400).json({ error: 'serverID and publicKey are required' });
    }
    const server = await getServer(serverID);
    if (server) {
      try {
        await provisioner.removePeer({ server, publicKey });
      } catch (err) {
        console.error(`[sessions] provisioner.removePeer failed for ${serverID}:`, err.message);
      }
    }
    await query('DELETE FROM peers WHERE server_id = $1 AND public_key = $2', [serverID, publicKey]);
    return res.status(204).end();
  }),
);

/** Premium check mirrors services/quota.isPremiumActive without importing device row twice. */
function isPremium(device) {
  if (!device || !device.is_premium) return false;
  if (!device.premium_expires_at) return true;
  return new Date(device.premium_expires_at).getTime() > Date.now();
}

/**
 * Allocate a free tunnel IP and insert a peer row, inside a transaction that
 * locks the server's peers so two concurrent /sessions can't grab the same IP.
 * Returns the new peer row, or null if the pool is exhausted.
 */
async function allocatePeer({ server, device, publicKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock this server's active peers to serialize IP allocation.
    const used = await client.query(
      'SELECT assigned_ip FROM peers WHERE server_id = $1 FOR UPDATE',
      [server.id],
    );
    const usedIps = new Set(used.rows.map((r) => r.assigned_ip));
    const ip = allocateAddress(server.tunnel_subnet, usedIps, server.max_peers);
    if (!ip) {
      await client.query('ROLLBACK');
      return null;
    }
    const psk = USE_PSK ? generatePresharedKey() : null;
    const { rows } = await client.query(
      `INSERT INTO peers (device_id, server_id, public_key, assigned_ip, preshared_key, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [device.id, server.id, publicKey, ip, psk],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
