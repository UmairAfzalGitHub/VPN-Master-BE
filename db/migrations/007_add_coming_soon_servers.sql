-- Add four "coming soon" locations as placeholder mock rows so they show in the
-- app (GET /v1/servers) as un-connectable "Coming soon" cells, exactly like the
-- original seed placeholders. provisioner='mock' ⇒ available=false in the API ⇒
-- the app renders a "COMING SOON" pill and ignores taps.
--
-- These are NOT real nodes: the public keys are syntactically valid but fake and
-- will not hand-shake. To go live later, stand up a droplet and run
-- scripts/activate-node.sh <id> (it UPDATEs the row to a real 'agent' node).
--
-- Each is pre-assigned a unique tunnel_subnet (see runbook §2) so activation
-- later stays collision-free. Idempotent via ON CONFLICT.

INSERT INTO servers (id, name, country, country_code, city, endpoint, public_key, tunnel_subnet, load, is_premium, provisioner)
VALUES
  ('ca-tor-01', 'Toronto',       'Canada',        'CA', 'Toronto',       'ca-tor-01.vpnmaster.example.net:51820', 'wz1Mkn52Nf0oQtZWT+WqJFzcKQvOp69kKV/e1e19HCw=', '10.14.0.0/16', 0.20, false, 'mock'),
  ('nl-ams-01', 'Amsterdam',     'Netherlands',   'NL', 'Amsterdam',     'nl-ams-01.vpnmaster.example.net:51820', 'bOERb6RTpwGUlHL7xxIa/SWsApMCEC0p5TENZ1xRGMk=', '10.15.0.0/16', 0.25, false, 'mock'),
  ('au-syd-01', 'Sydney',        'Australia',     'AU', 'Sydney',        'au-syd-01.vpnmaster.example.net:51820', 'ogTrJTPOGvuVGB/Wl+X1qxiRgkRAZztByLQQfdiyjjY=', '10.16.0.0/16', 0.15, false, 'mock'),
  ('us-sfo-01', 'San Francisco', 'United States', 'US', 'San Francisco', 'us-sfo-01.vpnmaster.example.net:51820', 'lVsHnsKGlH3ELElhwyxhysA43gXo7wwmtJC0Kvoyk4g=', '10.17.0.0/16', 0.30, false, 'mock')
ON CONFLICT (id) DO NOTHING;
