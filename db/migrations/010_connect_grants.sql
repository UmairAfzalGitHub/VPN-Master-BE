-- Connect grants: gate VPN connection *initiation* behind the app.
--
-- A gated client (new app versions) creates a peer that is NOT programmed onto
-- the node until it authorizes with a short-lived, single-use grant issued at
-- /sessions time. Connecting from iOS Settings / Control Center launches the
-- packet-tunnel extension with no grant, so it can never arm the peer.
--
-- Backward compatibility: `armed` defaults TRUE, so every existing peer (and
-- every peer created by a legacy, non-gated client) stays armed and behaves
-- exactly as before. Only gated clients ever create armed=false peers.

ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS armed            BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS grant_token      TEXT,
  ADD COLUMN IF NOT EXISTS grant_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grant_consumed   BOOLEAN NOT NULL DEFAULT false;

-- Reaper looks up un-armed reservations whose grant window has lapsed.
CREATE INDEX IF NOT EXISTS peers_unarmed_idx ON peers (grant_expires_at) WHERE NOT armed;
