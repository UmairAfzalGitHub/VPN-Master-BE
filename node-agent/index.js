'use strict';

/**
 * VPN Master — WireGuard node agent.
 *
 * Runs ON each WireGuard node (a Linux host). It is the ONLY thing that touches
 * `wg`; the control plane (on Render) drives it over HTTP. Deploy this to
 * /opt/vpn-agent/index.js and run it under systemd (see node-agent/README.md).
 *
 * Contract (matches services/provisioner/agent.js + services/usagePoller.js):
 *   Auth:   header `X-Agent-Secret: <AGENT_SECRET>` on every request.
 *   POST   /peers   { publicKey, assignedIp, presharedKey?, remainingBytes? }
 *   DELETE /peers   { publicKey }
 *   GET    /metrics -> { peers: [{ publicKey, rxBytes, txBytes, lastHandshake }] }
 *
 * Hardening vs. the first MVP:
 *   - inputs are STRICTLY validated and passed to `wg` via execFileSync (no
 *     shell) — closes the command-injection / RCE hole;
 *   - preshared keys are applied (written to a 0600 temp file, never a shell arg);
 *   - peers are persisted with `wg-quick save` so they survive a reboot.
 *
 * Still TODO (see BACKEND.md 6.3): arm an in-kernel nftables byte quota from
 * `remainingBytes` so the node drops traffic at the allowance. Accepted here for
 * forward-compat but not yet enforced — quota is bookkeeping-only for now.
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const app = express();
app.use(express.json());

const AGENT_SECRET = process.env.AGENT_SECRET || '';
const WG_INTERFACE = process.env.WG_INTERFACE || 'wg0';
const PORT = Number(process.env.AGENT_PORT || 8080);

// ---- validation ------------------------------------------------------------
// WireGuard keys are 32 bytes base64 => 43 chars + '='.
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

function isValidKey(k) {
  return typeof k === 'string' && WG_KEY_RE.test(k);
}

function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// ---- wg helpers (no shell — argv arrays only) ------------------------------
function wg(args, opts = {}) {
  return execFileSync('wg', args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

/** Persist the live interface config so peers survive a reboot. Best-effort. */
function persist() {
  try {
    execFileSync('wg-quick', ['save', WG_INTERFACE], { stdio: 'ignore' });
  } catch (err) {
    console.error(`[agent] wg-quick save failed: ${err.message}`);
  }
}

// ---- auth ------------------------------------------------------------------
app.use((req, res, next) => {
  if (!AGENT_SECRET) return res.status(503).json({ error: 'AGENT_SECRET not configured' });
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---- add / refresh a peer --------------------------------------------------
app.post('/peers', (req, res) => {
  const { publicKey, assignedIp, presharedKey } = req.body || {};
  if (!isValidKey(publicKey)) return res.status(400).json({ error: 'Invalid publicKey' });
  if (!isValidIpv4(assignedIp)) return res.status(400).json({ error: 'Invalid assignedIp' });
  if (presharedKey != null && !isValidKey(presharedKey)) {
    return res.status(400).json({ error: 'Invalid presharedKey' });
  }

  let pskFile = null;
  try {
    const args = ['set', WG_INTERFACE, 'peer', publicKey, 'allowed-ips', `${assignedIp}/32`];

    if (presharedKey) {
      // `wg set ... preshared-key` takes a FILE path, never an inline arg.
      pskFile = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), `psk-${process.pid}-${Date.now()}`);
      fs.writeFileSync(pskFile, `${presharedKey}\n`, { mode: 0o600 });
      args.push('preshared-key', pskFile);
    }

    wg(args);
    persist();
    return res.json({ success: true });
  } catch (err) {
    console.error(`[agent] add peer failed: ${err.message}`);
    return res.status(500).json({ error: 'wg set failed' });
  } finally {
    if (pskFile) fs.unlink(pskFile, () => {});
  }
});

// ---- remove a peer ---------------------------------------------------------
app.delete('/peers', (req, res) => {
  const { publicKey } = req.body || {};
  if (!isValidKey(publicKey)) return res.status(400).json({ error: 'Invalid publicKey' });
  try {
    wg(['set', WG_INTERFACE, 'peer', publicKey, 'remove']);
    persist();
    return res.json({ success: true });
  } catch (err) {
    console.error(`[agent] remove peer failed: ${err.message}`);
    return res.status(500).json({ error: 'wg set remove failed' });
  }
});

// ---- metrics (polled by the control plane) ---------------------------------
// `wg show <if> dump`: first line is the interface; peer lines are
// pubkey, psk, endpoint, allowedIps, latestHandshake, rx, tx, keepalive.
app.get('/metrics', (_req, res) => {
  try {
    const dump = wg(['show', WG_INTERFACE, 'dump']).toString().trim().split('\n').slice(1);
    const peers = dump.filter(Boolean).map((line) => {
      const p = line.split('\t');
      return {
        publicKey: p[0],
        rxBytes: parseInt(p[5] || '0', 10),
        txBytes: parseInt(p[6] || '0', 10),
        lastHandshake: parseInt(p[4] || '0', 10), // unix seconds, 0 = never
      };
    });
    return res.json({ peers });
  } catch (err) {
    console.error(`[agent] metrics failed: ${err.message}`);
    return res.status(500).json({ error: 'wg show failed' });
  }
});

app.listen(PORT, () => console.log(`VPN Agent running on port ${PORT} (iface ${WG_INTERFACE})`));
