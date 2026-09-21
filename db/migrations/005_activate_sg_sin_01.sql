-- Activate the real Singapore node (sg-sin-01) — flip it from the placeholder
-- 'mock' seed (migration 002) to a live 'agent' node backed by a DigitalOcean
-- droplet, exactly as 003/004 did for us-nyc-01 and de-fra-01.
--
-- Idempotent: 002 always seeds the row; this UPDATE just points it at the real
-- host, so it survives a DB recreation.
--
-- public_key / endpoint / agent_url are operational, non-secret values:
--   - public_key is the node's WireGuard PUBLIC key (private key stays on the node)
--   - agent_url is reachable only with the shared NODE_AGENT_SECRET (X-Node-Secret),
--     over TLS (self-signed IP-SAN cert committed at certs/sg-sin-01-agent.crt,
--     trusted in code by services/provisioner/nodeHttp.js)
--   - tunnel_subnet is 10.12.0.0/16 (distinct from us-nyc-01's 10.8.0.0/16 and
--     de-fra-01's 10.11.0.0/16)

UPDATE servers
SET endpoint      = '168.144.38.9:51820',
    public_key    = 'sBOj+I+B4NZxGLZHUYUqIdoQhSTr3IsOdwLKh57qGWU=',
    tunnel_subnet = '10.12.0.0/16',
    provisioner   = 'agent',
    agent_url     = 'https://168.144.38.9:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = 'sg-sin-01';
