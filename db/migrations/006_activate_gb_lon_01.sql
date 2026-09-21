-- Activate the real London node (gb-lon-01) — flip it from the
-- placeholder 'mock' seed (migration 002) to a live 'agent' node backed by a
-- DigitalOcean droplet. Idempotent: 002 always seeds the row; this UPDATE just
-- points it at the real host, so it survives a DB recreation.
--
-- public_key / endpoint / agent_url are operational, non-secret values.
-- tunnel_subnet 10.13.0.0/16 is unique to this node (see runbook §2).

UPDATE servers
SET endpoint      = '144.126.234.98:51820',
    public_key    = 't0S6QYqfWR2bzqjlo7s+3wxRgdnGz84Gn6T5w0knOWM=',
    tunnel_subnet = '10.13.0.0/16',
    provisioner   = 'agent',
    agent_url     = 'https://144.126.234.98:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = 'gb-lon-01';
