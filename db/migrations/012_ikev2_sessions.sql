-- IKEv2 migration, part 2 of 2: per-session EAP credentials.
--
-- WireGuard identifies a tunnel by the client's static public key (the `peers`
-- table). IKEv2 has no client key to register; instead the control plane mints
-- a short-lived EAP-MSCHAPv2 credential per connect and provisions it onto the
-- node's RADIUS. This table is the IKEv2 analogue of `peers`.
--
-- The credential TTL (`expires_at`) IS the connect-gate: a reconnect from the OS
-- Settings UI reuses a stale credential, which RADIUS rejects, so connecting
-- requires the app (docs/IKEV2-MIGRATION.md §6). `peers`/grants are untouched
-- and stay in use for WireGuard servers.

CREATE TABLE IF NOT EXISTS ikev2_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  -- EAP identity + secret handed to the node's RADIUS. We never need the
  -- plaintext again (RADIUS verifies it), so only a hash is retained here.
  eap_username      TEXT NOT NULL UNIQUE,
  eap_password_hash TEXT NOT NULL,              -- sha256(password), audit only
  -- Virtual IP strongSwan assigns from the node pool; learned from accounting
  -- (Framed-IP-Address) once the session is up. Nullable until then.
  assigned_ip       TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  revoked           BOOLEAN NOT NULL DEFAULT false,
  expires_at        TIMESTAMPTZ NOT NULL,       -- credential validity (connect-gate)
  last_handshake_at TIMESTAMPTZ,                -- last accounting activity, for reaping
  -- cumulative RADIUS accounting octets, previous reading — lets us accumulate
  -- DELTAS across counter resets, exactly like peers.last_sample_*.
  last_sample_rx    BIGINT NOT NULL DEFAULT 0,
  last_sample_tx    BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ikev2_sessions_device_active_idx
  ON ikev2_sessions (device_id) WHERE active;
CREATE INDEX IF NOT EXISTS ikev2_sessions_server_active_idx
  ON ikev2_sessions (server_id) WHERE active;
