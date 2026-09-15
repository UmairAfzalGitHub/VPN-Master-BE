-- VPN Master — control-plane schema.
-- See BACKEND.md in the VPNMasteriOS repo for the full contract.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- servers: the WireGuard nodes the user picks from (GET /v1/servers).
-- Only the server's PUBLIC key ever lives here; private keys stay on the node.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id            TEXT PRIMARY KEY,               -- stable id, e.g. "de-fra-01"
  name          TEXT NOT NULL,                  -- display name
  country       TEXT NOT NULL,
  country_code  TEXT NOT NULL,                  -- ISO 3166-1 alpha-2
  city          TEXT,
  endpoint      TEXT NOT NULL,                  -- "host:port" of the wg listener
  public_key    TEXT NOT NULL,                  -- server wg public key (base64)
  tunnel_subnet TEXT NOT NULL DEFAULT '10.7.0.0/16', -- pool /sessions allocates from
  dns           TEXT[] NOT NULL DEFAULT ARRAY['1.1.1.1', '1.0.0.1'],
  load          DOUBLE PRECISION,               -- 0..1, reported by the node agent
  is_premium    BOOLEAN NOT NULL DEFAULT false, -- gates behind IAP
  max_peers     INTEGER NOT NULL DEFAULT 60000, -- cap before pool exhaustion
  -- How the control plane programs peers on this node:
  --   'mock'  -> no real wg calls (dev / staging without a node)
  --   'agent' -> POST to agent_url (a small HTTP agent running on the node)
  provisioner   TEXT NOT NULL DEFAULT 'mock',
  agent_url     TEXT,                           -- base URL of the node agent (provisioner='agent')
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- devices: anonymous per-device identity. Created either by POST /v1/devices
-- (preferred, issues a bearer token) or lazily from a peer's public key when
-- the client hasn't adopted device tokens yet. Quota is tracked PER DEVICE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id          TEXT UNIQUE,               -- vendor id / random uuid from the client
  platform           TEXT,
  app_version        TEXT,
  is_premium         BOOLEAN NOT NULL DEFAULT false,
  premium_expires_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- peers: an active (or recently active) WireGuard peer = one device's tunnel
-- on one node. Idempotent per (server_id, public_key).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS peers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  public_key        TEXT NOT NULL,              -- client wg public key (base64)
  assigned_ip       TEXT NOT NULL,              -- host address, e.g. "10.7.0.23"
  preshared_key     TEXT,                       -- optional psk (base64)
  active            BOOLEAN NOT NULL DEFAULT true,
  last_handshake_at TIMESTAMPTZ,                -- for stale-peer reaping
  -- cumulative counters as last reported by the node agent (wg show transfer).
  -- last_sample_* is the previous raw reading, so we can accumulate DELTAS even
  -- across counter resets (peer re-add / node reboot).
  last_sample_rx    BIGINT NOT NULL DEFAULT 0,
  last_sample_tx    BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, public_key),
  UNIQUE (server_id, assigned_ip)
);

CREATE INDEX IF NOT EXISTS peers_device_active_idx ON peers (device_id) WHERE active;
CREATE INDEX IF NOT EXISTS peers_server_active_idx ON peers (server_id) WHERE active;

-- ---------------------------------------------------------------------------
-- usage_counters: the authoritative monthly RX+TX total PER DEVICE, summed
-- across every node the device roamed to this period. period_start is the
-- first day of the month (UTC). This is the ledger; the node kernel is the
-- enforcer (see BACKEND.md section 6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,                   -- first of month, UTC
  used_bytes   BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, period_start)
);
