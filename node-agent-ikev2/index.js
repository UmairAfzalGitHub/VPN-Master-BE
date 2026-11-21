'use strict';

/**
 * VPN Master — IKEv2/IPsec node agent (strongSwan + FreeRADIUS).
 *
 * Runs ON each IKEv2 node (a Linux host). It is the IKEv2 analogue of
 * ../node-agent/index.js: the ONLY thing the control plane (on Render) drives
 * over HTTP to manage this node. Deploy to /opt/vpn-agent-ikev2/index.js and run
 * under systemd (see node-agent-ikev2/README.md).
 *
 * On an IKEv2 node, strongSwan terminates the tunnel and delegates EAP-MSCHAPv2
 * auth to a local FreeRADIUS (eap-radius plugin). FreeRADIUS is SQL-backed, so
 * this agent manages credentials and reads usage purely by talking to the RADIUS
 * database — it never edits strongSwan config at runtime. It touches nothing
 * else on the box.
 *
 * Contract (matches services/provisioner/ikev2Agent.js + services/usagePoller.js):
 *   Auth:   header `X-Agent-Secret: <AGENT_SECRET>` on every request.
 *   POST   /credentials  { username, password, remainingBytes?, expiresAt? }
 *     -> upsert the EAP user in RADIUS; remember its quota/expiry for the sweep.
 *   DELETE /credentials  { username }
 *     -> delete the EAP user and CoA-disconnect any live SA.
 *   GET    /accounting
 *     -> { sessions: [{ username, rxBytes, txBytes, lastSeen, assignedIp }] }
 *
 * Enforcement (docs/IKEV2-MIGRATION.md §4, option 1 + node-side belt-and-braces):
 *   IKEv2 has no in-kernel per-flow byte cutoff like WireGuard's nftables quota.
 *   The control plane enforces from the ledger, and this agent ALSO sweeps: when
 *   a credential's RADIUS accounting crosses `remainingBytes`, or its `expiresAt`
 *   lapses, the agent deletes the credential and sends a RADIUS Disconnect
 *   (Dynamic Authorization Extension / CoA) so the live session drops promptly
 *   rather than only at the next control-plane poll. `remainingBytes == null`
 *   ⇒ unlimited ⇒ no byte enforcement.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const AGENT_SECRET = process.env.AGENT_SECRET || '';
const PORT = Number(process.env.AGENT_PORT || 8080);
// Optional TLS — identical scheme to the WireGuard agent: when TLS_CERT_FILE +
// TLS_KEY_FILE are set, serve HTTPS on AGENT_TLS_PORT and bind plain HTTP to
// loopback only. The control plane pins the self-signed cert via certs/*.crt.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
const TLS_PORT = Number(process.env.AGENT_TLS_PORT || 8443);

// FreeRADIUS SQL store (standard rlm_sql schema: radcheck + radacct).
const RADIUS_DATABASE_URL = process.env.RADIUS_DATABASE_URL || '';
// Dynamic Authorization (CoA/Disconnect) endpoint strongSwan listens on.
const DAE_SERVER = process.env.DAE_SERVER || '127.0.0.1:3799';
const DAE_SECRET = process.env.DAE_SECRET || '';

const SWEEP_INTERVAL_MS = Number(process.env.IKEV2_SWEEP_INTERVAL_MS || 15 * 1000);
const STATE_FILE = process.env.AGENT_STATE_FILE || '/var/lib/vpn-agent-ikev2/creds.json';

// ---- validation ------------------------------------------------------------
// Our control plane mints usernames like `u_<24 hex>`, but accept any safe EAP
// identity. The charset is deliberately tight so values are safe both in SQL
// params (belt) and as radclient stdin attributes (braces).
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]{1,128}$/; // base64url (crypto.randomBytes .base64url)

function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}
function isValidPassword(p) {
  return typeof p === 'string' && PASSWORD_RE.test(p);
}

// ---- RADIUS DB -------------------------------------------------------------
const radius = RADIUS_DATABASE_URL
  ? new Pool({
      connectionString: RADIUS_DATABASE_URL,
      ssl: String(process.env.RADIUS_PGSSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 4,
    })
  : null;

async function radQuery(text, params) {
  if (!radius) throw new Error('RADIUS_DATABASE_URL not configured');
  return radius.query(text, params);
}

/**
 * Upsert the EAP user's cleartext password in `radcheck`. FreeRADIUS derives the
 * NT-hash MSCHAPv2 needs from Cleartext-Password, so this one attribute is all
 * that's required.
 *
 * The stock FreeRADIUS schema only has a NON-unique index on (username,
 * attribute), so `ON CONFLICT (username, attribute)` fails ("no unique or
 * exclusion constraint matching the ON CONFLICT specification"). Replace the row
 * in one transaction instead — no schema change needed on the node.
 */
async function radUpsertUser(username, password) {
  if (!radius) throw new Error('RADIUS_DATABASE_URL not configured');
  const client = await radius.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM radcheck WHERE username = $1 AND attribute = 'Cleartext-Password'`,
      [username],
    );
    await client.query(
      `INSERT INTO radcheck (username, attribute, op, value)
       VALUES ($1, 'Cleartext-Password', ':=', $2)`,
      [username, password],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function radDeleteUser(username) {
  await radQuery('DELETE FROM radcheck WHERE username = $1', [username]);
}

/**
 * Cumulative accounting per username from `radacct`. A username is per-connect
 * unique, so this is effectively that session's RX+TX; the control-plane poller
 * turns it into monthly deltas. acctinputoctets/acctoutputoctets are the
 * byte counters strongSwan reports via eap-radius accounting.
 */
async function radAccounting() {
  const { rows } = await radQuery(
    `SELECT username,
            COALESCE(SUM(acctinputoctets), 0)  AS rx,
            COALESCE(SUM(acctoutputoctets), 0) AS tx,
            MAX(COALESCE(acctupdatetime, acctstarttime)) AS last_seen,
            (ARRAY_AGG(host(framedipaddress) ORDER BY acctstarttime DESC)
               FILTER (WHERE framedipaddress IS NOT NULL))[1] AS assigned_ip
       FROM radacct
      GROUP BY username`,
  );
  return rows.map((r) => ({
    username: r.username,
    rxBytes: Number(r.rx) || 0,
    txBytes: Number(r.tx) || 0,
    lastSeen: r.last_seen ? Math.floor(new Date(r.last_seen).getTime() / 1000) : 0,
    assignedIp: r.assigned_ip || null,
  }));
}

// ---- CoA / Disconnect (best-effort) ---------------------------------------
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
const RADCLIENT_BIN =
  process.env.RADCLIENT_BIN || resolveBin('radclient', ['/usr/bin/radclient', '/usr/sbin/radclient']);

/**
 * Send a RADIUS Disconnect-Request (DAE) to strongSwan so a live SA for this
 * user drops immediately. Best-effort: if radclient/DAE isn't set up, the
 * credential deletion + control-plane poll still tear the session down, just
 * less promptly. username is validated to a safe charset, and it's passed on
 * stdin (no shell), so there's no injection surface.
 */
function daeDisconnect(username) {
  if (!DAE_SECRET) return; // DAE not configured — skip quietly
  try {
    execFileSync(RADCLIENT_BIN, ['-x', DAE_SERVER, 'disconnect', DAE_SECRET], {
      input: `User-Name = "${username}"\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch (err) {
    // A "no session matched" reply also lands here — harmless. execFileSync's
    // message embeds the full command line, which contains DAE_SECRET (radclient
    // takes it as an argv), so redact it and keep just the first line.
    const msg = String(err.message || err).split(DAE_SECRET).join('***').split('\n')[0];
    console.error(`[ikev2-agent] DAE disconnect ${username}: ${msg}`);
  }
}

// ---- local registry (mirrored to STATE_FILE) ------------------------------
// username -> { remainingBytes, expiresAt(ms|null) }. Only what the SWEEP needs;
// RADIUS holds the credential itself. Survives an agent restart so quota/expiry
// enforcement isn't forgotten.
const creds = new Map();

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const obj = {};
    for (const [u, v] of creds) obj[u] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj), { mode: 0o600 });
  } catch (err) {
    console.error(`[ikev2-agent] saveState failed: ${err.message}`);
  }
}

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [u, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') creds.set(u, v);
    }
  } catch (err) {
    // no state yet — first boot
  }
}

// ---- periodic sweep: expiry + quota enforcement ---------------------------
async function sweepOnce() {
  if (!creds.size) return;
  let usage;
  try {
    usage = await radAccounting();
  } catch (err) {
    console.error(`[ikev2-agent] sweep accounting failed: ${err.message}`);
    return;
  }
  const byUser = new Map(usage.map((u) => [u.username, u]));
  const now = Date.now();

  for (const [username, v] of Array.from(creds)) {
    let drop = null;
    if (v.expiresAt && now > v.expiresAt) {
      drop = 'expired';
    } else if (v.remainingBytes != null) {
      const u = byUser.get(username);
      const used = u ? u.rxBytes + u.txBytes : 0;
      if (used >= v.remainingBytes) drop = `quota (${used}/${v.remainingBytes})`;
    }
    if (!drop) continue;

    console.log(`[ikev2-agent] dropping ${username} — ${drop}`);
    try {
      await radDeleteUser(username);
    } catch (err) {
      console.error(`[ikev2-agent] delete user on sweep failed (${username}): ${err.message}`);
      continue; // retry next pass rather than lose track of it
    }
    daeDisconnect(username);
    creds.delete(username);
    saveState();
  }
}

// ---- auth ------------------------------------------------------------------
app.use((req, res, next) => {
  if (!AGENT_SECRET) return res.status(503).json({ error: 'AGENT_SECRET not configured' });
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!radius) return res.status(503).json({ error: 'RADIUS_DATABASE_URL not configured' });
  next();
});

// ---- add / refresh a credential -------------------------------------------
app.post('/credentials', async (req, res) => {
  const { username, password, remainingBytes, expiresAt } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!isValidPassword(password)) return res.status(400).json({ error: 'Invalid password' });

  let quotaBytes = null;
  if (remainingBytes != null) {
    const n = Number(remainingBytes);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid remainingBytes' });
    quotaBytes = Math.round(n);
  }
  let expiresMs = null;
  if (expiresAt != null) {
    const t = new Date(expiresAt).getTime();
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'Invalid expiresAt' });
    expiresMs = t;
  }

  try {
    await radUpsertUser(username, password);
    creds.set(username, { remainingBytes: quotaBytes, expiresAt: expiresMs });
    saveState();
    return res.json({ success: true });
  } catch (err) {
    console.error(`[ikev2-agent] add credential failed: ${err.message}`);
    return res.status(500).json({ error: 'radius upsert failed' });
  }
});

// ---- remove a credential ---------------------------------------------------
app.delete('/credentials', async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  try {
    await radDeleteUser(username);
    daeDisconnect(username); // drop any live SA
    creds.delete(username);
    saveState();
    return res.json({ success: true });
  } catch (err) {
    console.error(`[ikev2-agent] remove credential failed: ${err.message}`);
    return res.status(500).json({ error: 'radius delete failed' });
  }
});

// ---- accounting (polled by the control plane) ------------------------------
app.get('/accounting', async (_req, res) => {
  try {
    const sessions = await radAccounting();
    return res.json({ sessions });
  } catch (err) {
    console.error(`[ikev2-agent] accounting failed: ${err.message}`);
    return res.status(500).json({ error: 'radius accounting failed' });
  }
});

// ---- boot ------------------------------------------------------------------
loadState();
const sweepHandle = setInterval(() => {
  sweepOnce().catch((err) => console.error(`[ikev2-agent] sweep failed: ${err.message}`));
}, SWEEP_INTERVAL_MS);
sweepHandle.unref?.();

const HTTP_BIND = TLS_CERT_FILE && TLS_KEY_FILE ? '127.0.0.1' : '0.0.0.0';
app.listen(PORT, HTTP_BIND, () =>
  console.log(`VPN IKEv2 Agent HTTP on ${HTTP_BIND}:${PORT}`),
);

if (TLS_CERT_FILE && TLS_KEY_FILE) {
  try {
    const https = require('https');
    const credentials = {
      cert: fs.readFileSync(TLS_CERT_FILE),
      key: fs.readFileSync(TLS_KEY_FILE),
    };
    https
      .createServer(credentials, app)
      .listen(TLS_PORT, () => console.log(`VPN IKEv2 Agent HTTPS on port ${TLS_PORT}`));
  } catch (err) {
    console.error(`[ikev2-agent] TLS disabled (HTTP still up): ${err.message}`);
  }
}

module.exports = { app, sweepOnce, radAccounting };
