# VPN Master — Backend Reference

The API the iOS and Android apps talk to, and how the control plane behaves. The tunnel is
**native IKEv2/IPsec** (iOS `NEVPNProtocolIKEv2`, Android `Ikev2VpnProfile`); WireGuard has
been removed. For the big picture and diagrams see [`ARCHITECTURE.md`](ARCHITECTURE.md); to
add a node see [`RUNBOOK-add-server.md`](RUNBOOK-add-server.md).

Live at `https://nyx-edge.onrender.com/v1` (Node/Express/Postgres on Render), **bare-body
responses**, camelCase.

---

## Implementation status

**Done**
- ✅ Postgres schema + forward-only migrations (014 removed WireGuard), seed servers.
- ✅ `X-API-Key` gate (fail-closed in production) + device bearer tokens.
- ✅ `GET /v1/servers` — catalog; `available` only for real IKEv2 nodes.
- ✅ `POST /v1/sessions` — token required; premium + quota gates; mints a short-lived
  EAP-MSCHAPv2 credential, provisions it on the node, returns the IKEv2 coordinates.
- ✅ `POST /v1/sessions/close` — token required, ownership-checked, idempotent.
- ✅ `POST /v1/devices` (+ `/subscription`, dev-only `/premium` and `/quota`),
  `GET /v1/usage`, `GET /v1/config`.
- ✅ Quota **ledger** in Postgres (per-device monthly RX+TX), usage poller, stale-session reaper.
- ✅ Node agent + strongSwan + FreeRADIUS; **London (`gb-lon-01`) is live**, verified with a
  real IKEv2 client (auth, accounting, quota cutoff).
- ✅ Boot-time DB retry (survives a database restart/maintenance).

**Not done yet**
- 🔲 Frankfurt, Singapore, New York still to convert (parked as "coming soon").
- 🔲 `POST /v1/purchases/validate` — IAP receipt validation (the app self-declares via `/devices/subscription`).
- 🔲 Production hardening: real Terms/Privacy URLs; rate-limiting `/sessions`; rotating setup
  secrets; separating the connect-gate TTL from session lifetime (below); exact byte cap;
  IPv6 for clients; pruning node `radacct`.
- 🔲 Apps: skip non-available servers; read `minSupportedVersion`/`forceUpdate`; Android
  connect timeout.

---

## 1. Conventions

- **Base URL:** `https://nyx-edge.onrender.com/v1/` (neutral hostname — no "vpn" — on purpose).
- **Transport:** HTTPS only. JSON bodies.
- **Auth:** every request carries `X-API-Key: <app key>`. Device-scoped calls also carry
  `Authorization: Bearer <deviceToken>` (from `POST /devices`).
- **Errors:** non-2xx with `{ "error": "<message>" }` (plus `quota` on a data-cap refusal).

| Code | Meaning |
|---|---|
| 400 | missing/invalid input |
| 401 | bad/missing API key, or **missing/stale device token** (the client re-registers) |
| 403 | premium-only server, or monthly data limit reached (`quota` in the body) |
| 404 | unknown server |
| 502 | the node couldn't be reached/programmed |

---

## 2. Endpoints

### 2.1 `GET /v1/servers`

```json
[{
  "id": "gb-lon-01", "name": "London", "country": "United Kingdom", "countryCode": "GB",
  "city": "London", "endpoint": "lon.outposttechnologies.co", "publicKey": "",
  "load": 0.18, "isPremium": true, "available": true
}]
```

- `endpoint` is the node **hostname** (catalog metadata; the connect coordinates come from
  `/sessions`). `publicKey` is a legacy field kept as `""` so existing client builds still decode it.
- `available` is `true` only when the row is enabled, `provisioner = 'ikev2'`, and has an
  `agent_url`. Everything else is "Coming soon".
- `?tier=free|premium` filters. Sorted by load.

### 2.2 `POST /v1/devices`

`{ "deviceId": "<stable client id>", "platform": "ios", "appVersion": "1.0" }` →
`201 { "token": "<JWT>", "expiresAt": "…" }`. Anonymous identity; idempotent on `deviceId`.

### 2.3 `POST /v1/sessions` — open a session (core)

Request (token required): `{ "serverID": "gb-lon-01" }`.

```json
{
  "protocol": "ikev2",
  "server": { "host": "lon.outposttechnologies.co", "remoteID": "lon.outposttechnologies.co", "caCert": null },
  "eap": { "username": "u_4c61…", "password": "<base64url>" },
  "dns": ["1.1.1.1", "1.0.0.1"],
  "expiresAt": "2026-11-22T07:43:35.907Z",
  "quota": { "isPremium": false, "unlimited": false, "limitBytes": 1073741824,
             "usedBytes": 0, "remainingBytes": 1073741824, "period": "monthly",
             "resetsAt": "2026-12-01T00:00:00.000Z" }
}
```

The control plane: authenticates the device → premium gate (403) → quota gate (403 + `quota`)
→ mints `(username, password)` → writes it to the node's RADIUS armed with the device's
**remaining** bytes → returns the coordinates. The app feeds `host`/`remoteID`/`eap` into
`NEVPNProtocolIKEv2` (iOS) / `Ikev2VpnProfile` (Android). `caCert` is unused — phones validate
the node's publicly trusted Let's Encrypt certificate against system trust.

`quota.usedBytes` counts **RX + TX combined** for the device across all nodes this period.

### 2.4 `POST /v1/sessions/close`

`{ "serverID": "gb-lon-01", "username": "u_4c61…" }` (token required) → `204`. Revokes the
credential (the node disconnects the live session) and drops the row. Only acts on the calling
device's own session; always answers 204 so it leaks nothing about other sessions.

### 2.5 `GET /v1/usage`

Token required. Returns the same `quota` shape as `/sessions`. 401 on a missing/stale token.

### 2.6 `GET /v1/config`

```json
{ "termsUrl": "…", "privacyUrl": "…", "minSupportedVersion": "1.0.0", "forceUpdate": false,
  "defaultDns": ["1.1.1.1","1.0.0.1"],
  "freePlan": { "limitBytes": 1073741824, "period": "monthly" },
  "premiumPlan": { "limitBytes": 10737418240, "period": "monthly" } }
```

Tunable via env (`FREE_LIMIT_BYTES`, `PREMIUM_LIMIT_BYTES`, `PREMIUM_UNLIMITED`, `TERMS_URL`,
`PRIVACY_URL`, `MIN_SUPPORTED_VERSION`, `FORCE_UPDATE`) without an app release.

### 2.7 `POST /v1/devices/subscription`

`{ "active": true }` (token required) → `{ isPremium, quota }`. The device self-declares
premium after an App Store purchase/restore (the client verifies the receipt with Apple; we
do not re-validate server-side).

### 2.8 Dev-only

`POST /v1/devices/premium` and `POST /v1/devices/quota` flip a device to premium / force a
specific cap for testing. They only honor devices whose client `device_id` is in
`DEV_UNLIMITED_DEVICE_IDS`, and 404 when that list is empty, so they're safe to leave deployed.

---

## 3. Quotas

- **Free:** 1 GB / month, RX+TX combined, **per device**. **Premium:** 10 GB (or unlimited with
  `PREMIUM_UNLIMITED=true`). Resets monthly (UTC).
- Postgres is the **ledger**; the **node enforces** the cap. At connect, the node is armed with
  the device's *remaining* bytes; its agent drops the credential (and the session) when
  accounting crosses it. The usage poller also revokes an exhausted device's credentials, and
  `/sessions` refuses an exhausted device until `resetsAt`.
- Enforcement latency ≈ accounting interval (15 s) + sweep (5 s) — not instantaneous; fast
  sessions can pass the cap by ~speed × 20 s.

## 4. The connect-gate

The credential TTL (`IKEV2_CRED_TTL_SECONDS`, default 24 h) is meant to be the gate that
requires the app to connect (a Settings-initiated reconnect uses a stale credential and is
rejected). Today it is **weak**: the credential is valid for up to 24 h, and a *short* TTL
would disconnect live sessions, because both the node's sweep and the reaper disconnect on
expiry. Making expiry stop *new* connects without ending live sessions is an open design item.
Credentials are also revoked on close, on quota, and by the reaper after 30 min without accounting.

## 5. Session lifecycle / reaping

The reaper (every 5 min) removes IKEv2 sessions that are expired or have had no accounting for
`PEER_TTL_MINUTES` (default 30), revoking the credential on the node. It relies on strongSwan's
interim accounting updates (`accounting_interval = 15`).

## 6. Environment

See `.env.example`. Notable: `DATABASE_URL`, `PGSSL`, `API_KEYS`, `JWT_SECRET`,
`NODE_AGENT_SECRET` (shared with every node agent), `IKEV2_CRED_TTL_SECONDS`,
`PEER_TTL_MINUTES`, `USAGE_POLL_INTERVAL_MS`, `DB_CONNECT_RETRIES` / `DB_CONNECT_DELAY_MS`
(boot-time DB retry).

## 7. Values the app needs (checklist)

1. Base URL `https://nyx-edge.onrender.com/v1` and the `X-API-Key`.
2. At least one `available: true` server (London today).
3. Terms & Privacy URLs (`TERMS_URL` / `PRIVACY_URL`).
4. Data caps via `/config`.
5. (Later) StoreKit product ids + receipt validation for Premium.
