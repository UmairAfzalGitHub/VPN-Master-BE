'use strict';

/**
 * VPN Master — WireGuard node agent.
 *
 * Runs ON each WireGuard node (a Linux host). It is the ONLY thing that touches
 * `wg` and `nftables`; the control plane (on Render) drives it over HTTP. Deploy
 * this to /opt/vpn-agent/index.js and run it under systemd (see node-agent/README.md).
 *
 * Contract (matches services/provisioner/agent.js + services/usagePoller.js):
 *   Auth:   header `X-Agent-Secret: <AGENT_SECRET>` on every request.
 *   POST   /peers   { publicKey, assignedIp, presharedKey?, remainingBytes? }
 *   DELETE /peers   { publicKey }
 *   GET    /metrics -> { peers: [{ publicKey, rxBytes, txBytes, lastHandshake }] }
 *
 * Hardening vs. the first MVP:
 *   - inputs are STRICTLY validated and passed to `wg`/`nft` via execFileSync (no
 *     shell) — closes the command-injection / RCE hole;
 *   - preshared keys are applied (written to a 0600 temp file, never a shell arg);
 *   - peers are persisted with `wg-quick save` so they survive a reboot.
 *
 * In-kernel quota enforcement (BACKEND.md 6.3):
 *   `remainingBytes` from the control plane is armed as a per-peer `nftables`
 *   byte quota in its own `table inet wgquota` (forward hook, policy accept — it
 *   only DROPS the over-quota flows, never anything else). RX+TX are counted
 *   together by pointing both a `saddr` and a `daddr` rule at one shared named
 *   quota object. The kernel drops the peer the instant it crosses the byte
 *   budget — no round-trip to the API. A periodic sweep then removes the peer
 *   from wg0 (so the tunnel drops and the app surfaces it) and tears down its
 *   nft objects. `remainingBytes == null` ⇒ unlimited ⇒ no quota is armed.
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
// Optional TLS: when TLS_CERT_FILE + TLS_KEY_FILE are set, ALSO serve HTTPS on
// AGENT_TLS_PORT (the control plane pins this self-signed cert via
// NODE_EXTRA_CA_CERTS). The plain-HTTP listener stays up so the switch is
// zero-downtime; close 8080 once agent_url has moved to https. See README.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
const TLS_PORT = Number(process.env.AGENT_TLS_PORT || 8443);
const NFT_TABLE = 'wgquota'; // family inet — kept separate from the NAT table
const SWEEP_INTERVAL_MS = Number(process.env.QUOTA_SWEEP_INTERVAL_MS || 15 * 1000);
const STATE_FILE = process.env.AGENT_STATE_FILE || '/var/lib/vpn-agent/peers.json';

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

// ---- wg / nft helpers (no shell — argv arrays only) ------------------------
// systemd gives services a minimal PATH (often no /usr/sbin), so resolve the
// binaries by absolute path rather than trusting PATH. `nft` in particular lives
// in /usr/sbin on Debian/Ubuntu.
function resolveBin(name, candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (err) {
      /* keep looking */
    }
  }
  return name; // fall back to PATH lookup
}

const WG_BIN = process.env.WG_BIN || resolveBin('wg', ['/usr/bin/wg', '/usr/sbin/wg', '/bin/wg']);
const WGQUICK_BIN = process.env.WGQUICK_BIN || resolveBin('wg-quick', ['/usr/bin/wg-quick', '/usr/sbin/wg-quick']);
const NFT_BIN = process.env.NFT_BIN || resolveBin('nft', ['/usr/sbin/nft', '/sbin/nft', '/usr/bin/nft', '/usr/local/sbin/nft']);

function wg(args, opts = {}) {
  return execFileSync(WG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function nft(args) {
  return execFileSync(NFT_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run nft and swallow failures (used where "already exists"/"not found" is fine). */
function nftTry(args) {
  try {
    nft(args);
    return true;
  } catch (err) {
    return false;
  }
}

/** Parse `nft -j …` output into the array under `.nftables`. */
function nftJson(args) {
  const out = nft(['-j', ...args]).toString();
  const parsed = JSON.parse(out);
  return Array.isArray(parsed.nftables) ? parsed.nftables : [];
}

/** Persist the live interface config so peers survive a reboot. Best-effort. */
function persist() {
  try {
    execFileSync(WGQUICK_BIN, ['save', WG_INTERFACE], { stdio: 'ignore' });
  } catch (err) {
    console.error(`[agent] wg-quick save failed: ${err.message}`);
  }
}

// ---- in-memory peer registry (mirrored to STATE_FILE) ----------------------
// publicKey -> { assignedIp, quotaName, bytes }. Only peers with an armed quota
// carry a quotaName; unlimited peers are tracked with quotaName === null so a
// later DELETE can still map publicKey -> ip if needed.
const peers = new Map();

function quotaName(ip) {
  // nft identifier: must start with a letter; dots aren't legal in a name.
  return `q_${ip.replace(/\./g, '_')}`;
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const obj = {};
    for (const [pk, v] of peers) obj[pk] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj), { mode: 0o600 });
  } catch (err) {
    console.error(`[agent] saveState failed: ${err.message}`);
  }
}

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [pk, v] of Object.entries(obj)) {
      if (v && typeof v.assignedIp === 'string') peers.set(pk, v);
    }
  } catch (err) {
    // no state yet — first boot
  }
}

// ---- nftables quota primitives --------------------------------------------

/** Idempotently create `table inet wgquota` with a default-accept forward chain. */
function ensureTable() {
  // `add table` is idempotent; a base chain re-add with the same spec is a no-op.
  nftTry(['add', 'table', 'inet', NFT_TABLE]);
  nftTry([
    'add', 'chain', 'inet', NFT_TABLE, 'forward',
    '{', 'type', 'filter', 'hook', 'forward', 'priority', '0', ';', 'policy', 'accept', ';', '}',
  ]);
}

/** All rule handles in our forward chain whose expression references `qname`. */
function ruleHandlesFor(qname) {
  let items;
  try {
    items = nftJson(['-a', 'list', 'chain', 'inet', NFT_TABLE, 'forward']);
  } catch (err) {
    return [];
  }
  const handles = [];
  for (const it of items) {
    if (it.rule && it.rule.handle != null && JSON.stringify(it.rule.expr || []).includes(qname)) {
      handles.push(it.rule.handle);
    }
  }
  return handles;
}

/** Remove a peer's two rules and its named quota object. Safe to call anytime. */
function removeQuota(ip) {
  const qname = quotaName(ip);
  for (const h of ruleHandlesFor(qname)) {
    nftTry(['delete', 'rule', 'inet', NFT_TABLE, 'forward', 'handle', String(h)]);
  }
  nftTry(['delete', 'quota', 'inet', NFT_TABLE, qname]);
}

/**
 * (Re)arm a peer's quota to `bytes`. Deleting first then recreating the named
 * quota object RESETS the counter, so re-adding the same peer never stacks rules
 * and always starts a fresh budget (idempotent, as required).
 */
function armQuota(ip, bytes) {
  const qname = quotaName(ip);
  removeQuota(ip); // clean slate — resets any prior counter for this IP
  // Shared named quota; both directions accrue into it => RX+TX combined.
  nft(['add', 'quota', 'inet', NFT_TABLE, qname, '{', 'over', String(bytes), 'bytes', '}']);
  nft(['add', 'rule', 'inet', NFT_TABLE, 'forward', 'ip', 'saddr', ip, 'quota', 'name', qname, 'drop']);
  nft(['add', 'rule', 'inet', NFT_TABLE, 'forward', 'ip', 'daddr', ip, 'quota', 'name', qname, 'drop']);
}

/** Map of quotaName -> { used, bytes } for every quota object in our table. */
function quotaUsage() {
  const map = new Map();
  let items;
  try {
    items = nftJson(['list', 'table', 'inet', NFT_TABLE]);
  } catch (err) {
    return map;
  }
  for (const it of items) {
    if (it.quota && it.quota.name) {
      map.set(it.quota.name, {
        used: Number(it.quota.used) || 0,
        bytes: Number(it.quota.bytes) || 0,
      });
    }
  }
  return map;
}

// ---- startup reconcile -----------------------------------------------------
// Restart (kernel state intact): keep live quotas as-is so counters aren't reset.
// Reboot (kernel state gone): re-arm remembered peers from their last-known
// budget. This is an approximation — the reboot loses the consumed counter, so a
// peer restored by `wg-quick` gets a fresh budget equal to its remaining bytes at
// last connect, not its live remaining. Reboots are rare, the Postgres ledger
// still refuses over-quota devices at /sessions, and the next reconnect re-arms
// with the correct remaining. See README "Persistence & the reboot trade-off".
function reconcileOnStartup() {
  ensureTable();
  loadState();
  const live = quotaUsage();
  for (const [, v] of peers) {
    if (v.quotaName && !live.has(v.quotaName)) {
      try {
        armQuota(v.assignedIp, v.bytes);
      } catch (err) {
        console.error(`[agent] re-arm ${v.assignedIp} failed: ${err.message}`);
      }
    }
  }
  saveState();
}

// ---- periodic quota sweep --------------------------------------------------
// When a peer's kernel quota is exhausted, the traffic is ALREADY being dropped.
// This sweep completes the teardown: remove the peer from wg0 (so the tunnel
// actually drops and the app surfaces it), free the nft objects, and drop it
// from our registry. The control plane's /metrics poll reconciles the final
// delta into its ledger.
function sweepOnce() {
  if (!peers.size) return;
  const live = quotaUsage();
  for (const [pk, v] of Array.from(peers)) {
    if (!v.quotaName) continue;
    const u = live.get(v.quotaName);
    if (!u || u.bytes <= 0) continue;
    if (u.used >= u.bytes) {
      console.log(`[agent] quota exhausted for ${v.assignedIp} (${u.used}/${u.bytes}) — removing peer`);
      try {
        wg(['set', WG_INTERFACE, 'peer', pk, 'remove']);
        persist();
      } catch (err) {
        console.error(`[agent] wg remove on exhaustion failed (${v.assignedIp}): ${err.message}`);
      }
      removeQuota(v.assignedIp);
      peers.delete(pk);
      saveState();
    }
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
  const { publicKey, assignedIp, presharedKey, remainingBytes } = req.body || {};
  if (!isValidKey(publicKey)) return res.status(400).json({ error: 'Invalid publicKey' });
  if (!isValidIpv4(assignedIp)) return res.status(400).json({ error: 'Invalid assignedIp' });
  if (presharedKey != null && !isValidKey(presharedKey)) {
    return res.status(400).json({ error: 'Invalid presharedKey' });
  }
  // null/undefined => unlimited (premium). Otherwise a finite, non-negative int.
  let quotaBytes = null;
  if (remainingBytes != null) {
    const n = Number(remainingBytes);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'Invalid remainingBytes' });
    }
    quotaBytes = Math.round(n);
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

    // Arm (or clear) in-kernel enforcement for this peer's tunnel IP.
    try {
      if (quotaBytes == null) {
        removeQuota(assignedIp); // e.g. upgraded to premium — drop any stale quota
        peers.set(publicKey, { assignedIp, quotaName: null, bytes: null });
      } else {
        armQuota(assignedIp, quotaBytes); // idempotent: resets the counter
        peers.set(publicKey, { assignedIp, quotaName: quotaName(assignedIp), bytes: quotaBytes });
      }
      saveState();
    } catch (err) {
      console.error(`[agent] arm quota failed (${assignedIp}): ${err.message}`);
      return res.status(500).json({ error: 'nft quota failed' });
    }

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

    // Tear down enforcement too. We need the peer's IP, which we tracked at add.
    const rec = peers.get(publicKey);
    if (rec) {
      removeQuota(rec.assignedIp);
      peers.delete(publicKey);
      saveState();
    }
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
    const peerRows = dump.filter(Boolean).map((line) => {
      const p = line.split('\t');
      return {
        publicKey: p[0],
        rxBytes: parseInt(p[5] || '0', 10),
        txBytes: parseInt(p[6] || '0', 10),
        lastHandshake: parseInt(p[4] || '0', 10), // unix seconds, 0 = never
      };
    });
    return res.json({ peers: peerRows });
  } catch (err) {
    console.error(`[agent] metrics failed: ${err.message}`);
    return res.status(500).json({ error: 'wg show failed' });
  }
});

// ---- boot ------------------------------------------------------------------
try {
  reconcileOnStartup();
} catch (err) {
  console.error(`[agent] nft bootstrap failed: ${err.message}`);
}
const sweepHandle = setInterval(() => {
  try {
    sweepOnce();
  } catch (err) {
    console.error(`[agent] sweep failed: ${err.message}`);
  }
}, SWEEP_INTERVAL_MS);
sweepHandle.unref?.();

// When TLS is configured, HTTPS is the public interface and plain HTTP binds to
// loopback only (on-box health checks still work, but nothing external reaches
// it). Without TLS, HTTP stays on all interfaces so a not-yet-cut-over node keeps
// working.
const HTTP_BIND = TLS_CERT_FILE && TLS_KEY_FILE ? '127.0.0.1' : '0.0.0.0';
app.listen(PORT, HTTP_BIND, () =>
  console.log(`VPN Agent HTTP on ${HTTP_BIND}:${PORT} (iface ${WG_INTERFACE})`),
);

// Optional TLS listener (same app, same auth) on all interfaces so the
// control-plane secret isn't sent in cleartext over the Render↔node transit.
// Best-effort: a cert problem disables HTTPS but never takes down HTTP.
if (TLS_CERT_FILE && TLS_KEY_FILE) {
  try {
    const https = require('https');
    const credentials = {
      cert: fs.readFileSync(TLS_CERT_FILE),
      key: fs.readFileSync(TLS_KEY_FILE),
    };
    https
      .createServer(credentials, app)
      .listen(TLS_PORT, () => console.log(`VPN Agent HTTPS on port ${TLS_PORT}`));
  } catch (err) {
    console.error(`[agent] TLS disabled (HTTP still up): ${err.message}`);
  }
}
