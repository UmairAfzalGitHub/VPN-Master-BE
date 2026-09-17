# VPN Master — Backend

Control-plane API for the **VPN Master** iOS client (`VPNMasteriOS`), a
WireGuard-based VPN. Node.js + Express + Postgres. Implements the contract in
the client's `BACKEND.md` (dynamic WireGuard model).

The control plane owns the **server catalog**, **per-device session/peer
negotiation**, **tunnel-IP allocation**, and the **monthly RX+TX quota ledger**.
The actual WireGuard nodes are separate Linux hosts; the control plane programs
their peers through a pluggable **provisioner** (`mock` by default, `agent` for
real nodes).

> Responses are **bare JSON bodies** (Option A in `docs/BACKEND.md`), so the
> current iOS client decodes them with no changes.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the app, control plane,
  and WireGuard node communicate (diagrams).
- [`docs/architecture.html`](docs/architecture.html) — the same, as a visual
  page you can open in a browser.
- [`docs/BACKEND.md`](docs/BACKEND.md) — the full backend spec + implementation
  status.

## Quick start (local)

```bash
cp .env.example .env          # set DATABASE_URL to a local Postgres
npm install
npm run db:migrate            # creates schema + seeds sample servers
npm run dev
```

Then, with the dev key from `.env` (`API_KEYS=dev-local-key`):

```bash
curl -s localhost:3000/v1/servers -H 'X-API-Key: dev-local-key'
curl -s -X POST localhost:3000/v1/sessions -H 'X-API-Key: dev-local-key' \
  -H 'Content-Type: application/json' \
  -d '{"serverID":"de-fra-01","publicKey":"TEST_CLIENT_PUBKEY_BASE64="}'
```

The seed servers use `provisioner='mock'` — `/sessions` returns a real
allocation and quota, but no kernel peer is programmed and the placeholder keys
won't hand-shake. This is intended for wiring up the API end-to-end before a
real node exists.

## Endpoints (`/v1`, all require `X-API-Key`)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/servers` | Server catalog (`?tier=free\|premium`). |
| POST | `/sessions` | Register device pubkey as a peer; returns tunnel params + `quota`. |
| POST | `/sessions/close` | Teardown: remove peer, free IP. |
| POST | `/devices` | Anonymous device identity → `{ token, expiresAt }`. |
| GET  | `/usage` | Current `quota` for the device (bearer token, `?deviceId`, or `?publicKey`). |
| GET  | `/config` | Terms/privacy URLs, min version, DNS, `freePlan`/`premiumPlan`. |

Internal (node agents only, header `X-Node-Secret`, not the app key):

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/nodes/:serverId/report` | Report per-peer `wg` transfer + handshakes; returns peers to cut. |

## Quota model

- Free: **1 GB / month, RX+TX combined, per device** (tunable via `/config`).
- Postgres is the **ledger** (authoritative monthly total, cross-node
  aggregation); the **VPN node kernel is the enforcer** (nftables byte quota
  armed with the device's *remaining* bytes at connect). See `BACKEND.md` §6.
- `/sessions` refuses over-quota devices with `403` + a `quota` body.

## Deploying a real WireGuard node

1. Stand up a Linux host with `wireguard`, IP forwarding, NAT/masquerade, and
   `nftables`. Give it a keypair; its **public** key + `host:port` go in a
   `servers` row.
2. Run a small **node agent** on it that:
   - `POST /peers` → `wg set wg0 peer <pk> allowed-ips <ip>/32 [preshared-key …]`
     and arms an `nftables` quota for `remainingBytes` on that tunnel IP;
   - `POST /peers/remove` → `wg set wg0 peer <pk> remove` + drop enforcement;
   - samples `wg show wg0 transfer` on a short interval and POSTs deltas to
     `/internal/nodes/:serverId/report` (auth: `X-Node-Secret`).
   The agent's HTTP contract is defined in `services/provisioner/agent.js`.
3. Insert/patch the `servers` row with `provisioner='agent'` and `agent_url`.

The agent process is host-specific (needs a real kernel + WireGuard) and lives
with the node, not in this repo.

## Handing values to iOS (BACKEND.md §7 checklist)

- Base URL: `https://<render-host>/v1`
- App key: the generated `API_KEYS` value → `APIConfiguration.defaultHeaders`
- At least one real node with a working `/servers` entry + `/sessions`
- Terms & Privacy URLs (`TERMS_URL` / `PRIVACY_URL`)
- Data caps via `/config`

## TODO / operational notes

- [x] **Render is on a paid tier** — the web service and `vpn-master-db` Postgres
      are both paid, so there are no cold starts and the database persists (no more
      30-day free-tier expiry). Data survives across deploys.
- [ ] Set real `TERMS_URL` / `PRIVACY_URL` (Settings + onboarding links).
- [ ] Rotate `API_KEYS` / `JWT_SECRET` off any values shared during setup.
- [x] Stand up at least one real WireGuard node + agent and flip its `servers`
      row to `provisioner='agent'` — done: `us-nyc-01` is live with in-kernel
      nftables quota enforcement (see `node-agent/README.md`). More regions
      (`gb-lon-01`, `de-fra-01`, `sg-sin-01`) are still mock.
- [x] Have the iOS client adopt `POST /devices` + `Authorization: Bearer` so
      quota is per-device, not per-keypair — done; verified usage accumulates
      across a WireGuard key rotation on `us-nyc-01`.
- [x] Restrict the node agent's TCP port to the control plane — done:
      `us-nyc-01` firewalls 8080 to Render's outbound ranges via an nftables
      `portfilter` table (see `node-agent/README.md`).
- [x] Put the node agent behind TLS — done: `us-nyc-01` serves HTTPS on 8443
      with a self-signed IP-SAN cert (no domain), committed at
      `certs/us-nyc-01-agent.crt` and trusted in code
      (`services/provisioner/nodeHttp.js`); `agent_url` is `https://…:8443`.
      Plain HTTP is loopback-only and closed at the firewall; ufw (8443 → Render
      only) is the single firewall. See `node-agent/README.md` → "TLS".

## Layout

```
server.js                 app wiring, health, boot
db/                       pool, forward-only migrations, schema + seed
routes/                   servers, sessions, devices, usage, config, internal
services/                 quota ledger, device identity, config, reaper, provisioner/
middleware/               X-API-Key gate, optional device token, async wrapper
utils/ip.js               tunnel-IP pool allocation
```
