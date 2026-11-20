-- IKEv2 migration, part 1 of 2: make `servers` protocol-aware.
--
-- The fleet is WireGuard today; this adds a per-server `protocol` so WireGuard
-- and IKEv2/IPsec nodes can coexist during rollout (docs/IKEV2-MIGRATION.md §9).
-- Existing rows default to 'wireguard', so nothing changes for them.
--
-- For an IKEv2 server:
--   - protocol      = 'ikev2'
--   - provisioner   = 'ikev2'  (selects the strongSwan/RADIUS node agent) or
--                     'mock'    (run the API with no node, like WireGuard mock)
--   - endpoint      = the node HOST only (no :port — IKE uses UDP 500/4500)
--   - ike_remote_id = the server certificate identity (SAN) the client validates
--   - ca_cert       = PEM of the CA/leaf cert clients should trust (optional if
--                     the apps bundle the CA); PUBLIC, non-secret.
--   - public_key    is unused (kept NOT NULL for WireGuard; set '' for ikev2)

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS protocol      TEXT NOT NULL DEFAULT 'wireguard',
  ADD COLUMN IF NOT EXISTS ike_remote_id TEXT,
  ADD COLUMN IF NOT EXISTS ca_cert       TEXT;

-- Constrain protocol to known values (idempotent: drop-then-add).
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_protocol_chk;
ALTER TABLE servers
  ADD CONSTRAINT servers_protocol_chk CHECK (protocol IN ('wireguard', 'ikev2'));
