-- Remove WireGuard from the schema: IKEv2/IPsec is now the only protocol.
--
-- DESTRUCTIVE and not reversible (forward-only migrations): it drops the `peers`
-- table. That table only held per-device WireGuard peers (with the connect-grant
-- columns added by 010); nothing in the IKEv2 path reads it. `ikev2_sessions`
-- (012) is its replacement. Device identity (`devices`) and the monthly ledger
-- (`usage_counters`) are untouched, so quotas carry over.

-- 1. WireGuard peers (+ their indexes, constraints and the grant columns).
DROP TABLE IF EXISTS peers;

-- 2. WireGuard-only columns on `servers`.
--      protocol    -- 011 added it to run both protocols side by side
--      max_peers   -- WireGuard tunnel-IP pool cap (strongSwan assigns IPs now)
--      public_key  -- the node's WireGuard public key (IKEv2 uses a certificate)
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_protocol_chk;
ALTER TABLE servers
  DROP COLUMN IF EXISTS protocol,
  DROP COLUMN IF EXISTS max_peers,
  DROP COLUMN IF EXISTS public_key;

-- 3. Servers still on the old WireGuard agent (provisioner = 'agent') have no
--    node that speaks IKEv2 yet. Park them as 'mock' so the API reports
--    `available: false` and the apps show them as "Coming soon". Their droplets
--    are untouched; convert each with docs/RUNBOOK-add-server.md and set its
--    provisioner back to 'ikev2' with the real host and agent_url.
UPDATE servers
SET provisioner = 'mock',
    agent_url   = NULL,
    updated_at  = now()
WHERE provisioner = 'agent';

-- 4. `provisioner` now has exactly two values.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_provisioner_chk;
ALTER TABLE servers
  ADD CONSTRAINT servers_provisioner_chk CHECK (provisioner IN ('ikev2', 'mock'));
