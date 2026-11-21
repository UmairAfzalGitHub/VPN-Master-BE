-- Convert the London node (gb-lon-01) from WireGuard to native IKEv2/IPsec.
--
-- The droplet now runs strongSwan + FreeRADIUS + the IKEv2 node agent
-- (node-agent-ikev2/) instead of wg + the WireGuard agent. Same droplet and IP.
--
-- For an IKEv2 server (see 011_ikev2_protocol.sql):
--   endpoint      = the node HOSTNAME only (no :port; IKE uses UDP 500/4500). It must
--                   match the TLS cert the phones validate against system trust
--                   (Let's Encrypt, issued for this name) — NOT a bare IP.
--   ike_remote_id = the cert identity (SAN) the client checks; same as endpoint.
--   ca_cert       = NULL; clients use the system trust store, nothing is bundled.
--   public_key    = '' (WireGuard-only column, kept NOT NULL).
--   tunnel_subnet = the strongSwan virtual-IP pool (swanctl pools.vip_pool).
--   agent_url     = the IKEv2 node agent over TLS. It reuses the node's existing
--                   self-signed agent cert, already committed as
--                   certs/gb-lon-01-agent.crt (SAN = this IP) and trusted by
--                   services/provisioner/nodeHttp.js, so no new cert is needed.
--
-- Non-secret operational values only; the agent secret lives in env vars.

UPDATE servers
SET protocol      = 'ikev2',
    provisioner   = 'ikev2',
    endpoint      = 'lon.outposttechnologies.co',
    ike_remote_id = 'lon.outposttechnologies.co',
    ca_cert       = NULL,
    public_key    = '',
    tunnel_subnet = '10.20.0.0/16',
    agent_url     = 'https://144.126.234.98:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = 'gb-lon-01';
