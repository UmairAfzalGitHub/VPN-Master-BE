-- Activate the real Frankfurt node (de-fra-01) — flip it from the placeholder
-- 'mock' seed (migration 002) to a live 'agent' node backed by a DigitalOcean
-- droplet, exactly as 003 did for us-nyc-01.
--
-- Idempotent: 002 always seeds the row; this UPDATE just points it at the real
-- host, so it survives a DB recreation.
--
-- public_key / endpoint / agent_url are operational, non-secret values:
--   - public_key is the node's WireGuard PUBLIC key (private key stays on the node)
--   - agent_url is reachable only with the shared NODE_AGENT_SECRET (X-Node-Secret),
--     over TLS (self-signed IP-SAN cert committed at certs/de-fra-01-agent.crt,
--     trusted in code by services/provisioner/nodeHttp.js)
--   - tunnel_subnet is 10.11.0.0/16 (distinct from us-nyc-01's 10.8.0.0/16)

UPDATE servers
SET endpoint      = '164.90.168.100:51820',
    public_key    = 'DNBg8iBvwokppXULEVEh0/DSbPSTK5bIBc2vmjMgJTA=',
    tunnel_subnet = '10.11.0.0/16',
    provisioner   = 'agent',
    agent_url     = 'https://164.90.168.100:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = 'de-fra-01';
