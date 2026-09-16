-- Activate the real US node (us-nyc-01) — flip it from the placeholder 'mock'
-- seed (migration 002) to a live 'agent' node backed by a DigitalOcean droplet.
--
-- Idempotent: 002 always seeds the row; this UPDATE just points it at the real
-- host, so it survives a DB recreation (free Render Postgres expires in 30d).
--
-- public_key / endpoint / agent_url are operational, non-secret values:
--   - public_key is the node's WireGuard PUBLIC key (private key stays on the node)
--   - agent_url is reachable only with the shared NODE_AGENT_SECRET (X-Node-Secret)

UPDATE servers
SET endpoint      = '192.34.58.185:51820',
    public_key    = 'JXpZ1ezMQWeMF9AWDL+hJleMh2XvYvEPGBAsJHJmBXM=',
    tunnel_subnet = '10.8.0.0/16',
    provisioner   = 'agent',
    agent_url     = 'http://192.34.58.185:8080',
    enabled       = true,
    updated_at    = now()
WHERE id = 'us-nyc-01';
