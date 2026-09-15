-- Sample servers so GET /v1/servers returns something immediately.
-- These are PLACEHOLDERS running provisioner='mock' (no real WireGuard node
-- behind them). Replace public_key / endpoint / agent_url with real nodes and
-- flip provisioner to 'agent' once a node + agent is deployed.
--
-- The public keys below are syntactically valid base64 32-byte keys but are
-- NOT real server keys — a tunnel built against them will not hand-shake.

INSERT INTO servers (id, name, country, country_code, city, endpoint, public_key, tunnel_subnet, load, is_premium, provisioner)
VALUES
  ('de-fra-01', 'Frankfurt',    'Germany',        'DE', 'Frankfurt',    'de-fra-01.vpnmaster.example.net:51820', 'iX8Xh0dQ2r7m0mVQ1m9x2q3F5v8gQ1sJt2b3c4d5e6f=', '10.7.0.0/16',  0.31, false, 'mock'),
  ('us-nyc-01', 'New York',     'United States',  'US', 'New York',     'us-nyc-01.vpnmaster.example.net:51820', 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c=', '10.8.0.0/16',  0.52, false, 'mock'),
  ('gb-lon-01', 'London',       'United Kingdom', 'GB', 'London',       'gb-lon-01.vpnmaster.example.net:51820', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6=', '10.9.0.0/16',  0.18, false, 'mock'),
  ('sg-sin-01', 'Singapore',    'Singapore',      'SG', 'Singapore',    'sg-sin-01.vpnmaster.example.net:51820', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c=', '10.10.0.0/16', 0.44, true,  'mock')
ON CONFLICT (id) DO NOTHING;
