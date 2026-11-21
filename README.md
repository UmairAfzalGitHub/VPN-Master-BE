# VPN Master — Backend

Control-plane API for the VPN Master iOS and Android apps, a native **IKEv2/IPsec** VPN.
Node.js + Express + Postgres.

The control plane owns the **server catalog**, **per-device identity**, **per-connect EAP
credentials**, and the **monthly RX+TX quota ledger**. The actual VPN nodes are separate Linux
hosts (strongSwan + FreeRADIUS + a small agent); the control plane drives them over HTTPS
through a pluggable **provisioner** (`ikev2` for real nodes, `mock` for dev). Your VPN traffic
never touches this service.

> Responses are **bare JSON** (no envelope), camelCase.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the apps, control plane and nodes fit
  together (diagrams): connect sequence, metering loop, data model, security, ports.
- [`docs/BACKEND.md`](docs/BACKEND.md) — API reference, quotas, status.
- [`docs/RUNBOOK-add-server.md`](docs/RUNBOOK-add-server.md) — **step-by-step: add or convert a
  node** (every command, with verification and the gotchas we hit).
- [`node-agent/README.md`](node-agent/README.md) — the node agent's contract and configuration.
- [`docs/IKEV2-MIGRATION.md`](docs/IKEV2-MIGRATION.md) — the WireGuard → IKEv2 plan (historical).

## Quick start (local)

```bash
cp .env.example .env          # set DATABASE_URL to a local Postgres
npm install
npm run db:migrate            # creates the schema + seeds sample servers
npm run dev
```

Then, with the dev key from `.env` (`API_KEYS=dev-local-key`):

```bash
curl -s localhost:3000/v1/servers -H 'X-API-Key: dev-local-key'

# a device identity, then a session (use the token it returns)
TOKEN=$(curl -s -X POST localhost:3000/v1/devices -H 'X-API-Key: dev-local-key' \
  -H 'Content-Type: application/json' -d '{"deviceId":"my-test-device"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X POST localhost:3000/v1/sessions -H 'X-API-Key: dev-local-key' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"serverID":"gb-lon-01"}'
```

Seed servers use `provisioner='mock'`: `/sessions` returns a real credential and quota, but no node
is programmed and the tunnel won't authenticate. They report `available: false` ("Coming soon").
Only rows with `provisioner='ikev2'`, an `agent_url` and `enabled` are connectable.

> `db/migrations/001` runs `CREATE EXTENSION pgcrypto`; a Postgres without that extension
> (e.g. an in-process test database) needs it removed — `gen_random_uuid()` is built in from
> Postgres 13.

## Endpoints (`/v1`, all require `X-API-Key`)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/servers` | Server catalog (`?tier=free\|premium`). |
| POST | `/devices` | Anonymous device identity → `{ token, expiresAt }`. |
| POST | `/sessions` | Mint an EAP credential; returns IKEv2 coordinates + `quota` (device token required). |
| POST | `/sessions/close` | Revoke the credential (device token required, ownership-checked). |
| GET  | `/usage` | Current `quota` for the device (device token required). |
| GET  | `/config` | Terms/privacy URLs, min version, DNS, `freePlan`/`premiumPlan`. |
| POST | `/devices/subscription` | Self-declare premium after an App Store purchase. |

Dev-only (allow-listed devices): `POST /devices/premium`, `POST /devices/quota`.

## Quota model

- Free: **1 GB / month, RX+TX combined, per device**; premium 10 GB (tunable via `/config`).
- Postgres is the **ledger**; the **node enforces** it. At connect the node is armed with the
  device's *remaining* bytes and its agent drops the session when accounting crosses it;
  `/sessions` refuses an exhausted device with `403` + a `quota` body.

## Adding a node

Follow [`docs/RUNBOOK-add-server.md`](docs/RUNBOOK-add-server.md): size a 1 GB droplet, add a
Cloudflare DNS record, get a Let's Encrypt certificate, install strongSwan + FreeRADIUS + the
agent, then register the node with a migration and push. Each node needs its own **hostname**
(the apps validate a publicly trusted certificate), **virtual-IP pool** and **agent certificate**
(`certs/<id>-agent.crt`).

## Operational notes / TODO

- [x] Render web service (`nyx-edge`) + Postgres (`vpn-master-db`) on paid tiers.
- [x] Native IKEv2 end to end; WireGuard removed (migration 014).
- [x] London (`gb-lon-01`) live and verified with a real client (macOS profile and the iOS app).
- [x] `render.yaml` reconciled with the live `nyx-edge` service (plan lines still to be confirmed in the dashboard).

**Do these next**

- [ ] **Revert London to a premium server.** It was switched to FREE by hand in the production
      database so a free device could test it (nothing in git sets this, so a redeploy keeps it).
      Undo it once a free node exists (New York is the intended free server):
      ```sql
      UPDATE servers SET is_premium = true, updated_at = now() WHERE id = 'gb-lon-01';
      ```
      Run it with `psql "<External Database URL>"` (Render → `vpn-master-db` → Connect → External).
- [ ] **Resize the other droplets to 1 GB and add their DNS records**, then convert them with
      [`docs/RUNBOOK-add-server.md`](docs/RUNBOOK-add-server.md) (parked as "coming soon" until then):
      Frankfurt `fra` → `164.90.168.100`, Singapore `sin` → `168.144.38.9`, New York `nyc` →
      `192.34.58.185`, each `<name>.outposttechnologies.co` in Cloudflare as an `A` record, **DNS
      only (grey cloud)**. The $6 / 1 GB plan was unavailable in Frankfurt (try Premium Intel ~$8, or
      another region). Until New York is converted there is **no free-tier server** — only London.

**Later**

- [ ] Set real `TERMS_URL` / `PRIVACY_URL`; rotate `API_KEYS` / `JWT_SECRET` off any shared values.
- [ ] Rate-limit `/sessions`; separate the connect-gate TTL from session lifetime; IAP receipt validation
      (`/devices/subscription` currently trusts the device — anyone with the app key can self-grant premium).
- [ ] Pin IKEv2 algorithms on both apps and the nodes (a phone negotiated AES-256-CBC / DH group 14), and
      prune node `radacct` + shorten backend session retention so the "no logs" wording is accurate.
- [ ] Set `AppStoreLink.appID` in the iOS app once there is a store listing (the forced-update button).

## Layout

```
server.js                 app wiring, health, boot (waits for the DB, runs migrations)
db/                       pool, forward-only migrations, schema + seed
routes/                   servers, sessions, devices, usage, config
services/                 quota ledger, device identity, IKEv2 session lifecycle,
                          usage poller, reaper, provisioner/ (agent + mock)
middleware/               X-API-Key gate, device token, async wrapper
node-agent/               the agent that runs ON each node (strongSwan + FreeRADIUS)
certs/                    each node agent's PUBLIC self-signed cert (pinned by the control plane)
docs/                     architecture, backend reference, add-a-node runbook
```
