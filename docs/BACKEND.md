# VPN Master — Backend Requirements

Spec for the backend that the iOS app (`VPNMasteriOS`) talks to. The client is
**WireGuard-based** (wireguard-go via WireGuardKit) and is already written
against the API described here — see `App/Services/ServerRepository.swift`,
`App/Core/Networking/*`, and `App/Services/VPNService.swift`.

> This spec now lives in the **backend** repo (`VPN-Master-BE`). It was moved
> here from the iOS repo so the requirements and their implementation live
> together. See the status section below for what's built.

---

## Implementation status

Snapshot of this repo against the spec. Live at
`https://nyx-edge.onrender.com/v1` (Node/Express/Postgres on Render),
**bare-body responses (Option A)** — the current iOS client decodes them
unchanged.

**Done**
- ✅ Project scaffold, Postgres schema + forward-only migrations, seed servers,
  Render blueprint. Boots and migrates on deploy.
- ✅ `X-API-Key` gate (fail-closed in production) + optional device bearer token.
- ✅ **`GET /v1/servers`** — catalog from Postgres, `?tier` filter (§2.1).
- ✅ **`POST /v1/sessions`** — device resolution, premium + quota gates, unique
  tunnel-IP allocation (tx-locked), PSK, idempotent re-registration, returns
  `quota` (§2.2).
- ✅ **`POST /v1/sessions/close`** — teardown / peer removal (§2.3).
- ✅ **`POST /v1/devices`** — anonymous device identity + token (§2.4).
- 🛠️ **`POST /v1/devices/premium`** — **dev-only** unlimited-data toggle. Requires
  the caller's device bearer token **and** its client `device_id` to be listed in
  `DEV_UNLIMITED_DEVICE_IDS` (comma-separated); any other device gets 403, and an
  empty list 404s. Because it's allowlisted per device, it's **safe to leave set
  in production** — no other user can self-grant premium. Sets that device's
  `is_premium`. Body: `{ "enabled": true|false }` → `{ isPremium, quota }`. Backs
  the iOS Settings "Unlimited Data (Dev)" switch (the app prints the device id on
  launch in DEBUG). For genuinely unlimited (not the 100 GB premium cap), also set
  `PREMIUM_UNLIMITED=true`.
- ✅ **`GET /v1/usage`** — quota meter by token / `?deviceId` / `?publicKey` (§2.5).
- ✅ **`GET /v1/config`** — remote config + free/premium plans (§2.7).
- ✅ Quota **ledger** in Postgres (per-device monthly RX+TX), stale-peer reaper,
  `/internal/nodes/:id/report` for node agents to report deltas (§5, §6.1–6.2).
- ✅ Pluggable **provisioner**: `mock` (default; runs with no WG node) + `agent`
  HTTP contract for a real node.
- ✅ **Real WireGuard node + agent** — `us-nyc-01` (`provisioner='agent'`) is a
  live Linux WG host running `wg` + the node agent (`node-agent/index.js`,
  deployed to the droplet). Real handshakes, real tunnel-IP allocation from
  `10.8.0.0/16` (§3).
- ✅ **Network-level quota enforcement (§6.3)** — the node agent arms an in-kernel
  `nftables` per-peer byte quota (`table inet wgquota`) from `remainingBytes`,
  counting RX+TX combined; the kernel drops the peer at its allowance and a sweep
  removes it from `wg0`. Verified end-to-end on the droplet (see
  `node-agent/README.md`). Postgres decides the number; the node enforces it.
- ✅ **Per-device quota across key rotation (§2.4/§6)** — the iOS client now sends
  `Authorization: Bearer <deviceToken>`, so quota follows the device across
  WireGuard keypairs instead of resetting each reconnect. Verified end-to-end
  against `us-nyc-01` (usage accumulated across a key rotation).

**Not done yet**
- 🔲 **`POST /v1/purchases/validate`** — IAP receipt validation, Premium (§2.6).
- 🔲 **More real regions** — only `us-nyc-01` is live; `gb-lon-01`, `de-fra-01`,
  `sg-sin-01` still point at `*.vpnmaster.example.net` and are mock/unreachable.
- ✅ **Client-side gaps (§8)** — all closed: `X-API-Key`, live `baseURL`, device
  `Bearer` token, token-keyed `/usage`, `POST /sessions/close` on disconnect,
  default-server persistence (last server restored on launch), and the near-cap
  warning + data-limit upsell UI (Home banner + upgrade CTA on a 403 quota
  refusal). Client work lives in the `VPN-Master-iOS` repo.
- 🔲 **Production hardening** — remaining: real Terms/Privacy URLs; rate-limiting
  `/sessions`; rotating setup secrets. Done: Render web service + Postgres are on
  a paid tier (no cold starts, Postgres persists — no more 30-day expiry); the
  agent's TCP port is restricted to the control plane and served over TLS.

See `README.md` for run/deploy details and the per-file layout.

---

## 0. Context: this is NOT the old Mercury app's model

The previous app (`VPN-iOS` / "Mercury VPN") used **IKEv2/IPSec** with a single
`GET getIosServers` endpoint that returned a static list of servers, each with
`username` / `password` / `certificate` embedded (AES-CBC obfuscated with a key
hardcoded in the app). Every user shared the same credentials; there was no
per-user session and effectively no real backend logic — the "API" was a static
JSON file behind a static header key.

**WireGuard cannot reuse that model as-is.** WireGuard has no username/password.
Every connecting device is a *peer* identified by its public key, and the server
must know that public key to accept the handshake and route the peer's tunnel IP.
So one of two models applies:

| | Static (Mercury-style) | Dynamic (recommended) |
|---|---|---|
| Server list | embeds a shared WireGuard privkey + address | embeds only the server's **public** key |
| Peer registration | none | `POST /sessions` registers the device pubkey |
| Per-device tunnel IP | ❌ collisions if shared | ✅ backend allocates from a pool |
| Security | shared key in every binary | private key never leaves device |
| Backend work | almost none | manage `wg` peers per node |

> **Recommendation: build the dynamic model.** It's what the app already codes
> against, it's the correct WireGuard security model, and it avoids IP/handshake
> collisions. The rest of this doc specs the dynamic model, and flags where you
> could cut corners toward the static one.

---

## 1. Conventions

- **Base URL:** `https://<host>/v1/` (client reads it from
  `App/Core/Networking/APIConfiguration.swift` — currently the placeholder
  `https://api.vpnmaster.example.com/v1`). Provide a **DEBUG/staging** URL and a
  **Release/prod** URL.
- **Transport:** HTTPS only (TLS 1.2+). JSON request/response bodies.
- **Auth header:** every request carries a static app key, matching how the old
  app worked but renamed for clarity:
  `X-API-Key: <app_key>` (client already has an `X-API-Key` header enum in
  `HTTPMethod.swift`). Optionally add a per-device bearer token (see §6).
- **Response envelope (decide one and keep it consistent):**
  - *Option A — bare bodies* (what the client decodes **today**): `GET /servers`
    returns a raw JSON array; `POST /sessions` returns a raw object.
  - *Option B — envelope* (consistent with your other apps' `AppResponse<T>`):
    `{ "success": bool, "error": string?, "errors": [{message}]?, "data": T }`.
    If you choose B, the client's `ServerRepository` / `NetworkService` need a
    small change to unwrap `data` (noted in §7).
- **Errors:** non-2xx → the client throws `APIError.unacceptableStatusCode`. Use
  standard codes: `400` bad input, `401` bad/missing key, `403` premium-gated,
  `404` unknown server, `429` rate limit, `5xx` server. Put a human message in
  the body.

---

## 2. Endpoints

### 2.1 `GET /v1/servers` — server catalog  **(required)**

Returns the list the user picks from. Client model: `VPNServer`
(`App/Features/Servers/Models/VPNServer.swift`).

**Response (bare-body form):**
```json
[
  {
    "id": "de-fra-01",
    "name": "Frankfurt",
    "country": "Germany",
    "countryCode": "DE",
    "city": "Frankfurt",
    "endpoint": "de-fra-01.vpnmaster.net:51820",
    "publicKey": "SERVER_WG_PUBLIC_KEY_BASE64=",
    "load": 0.31,
    "isPremium": false
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable server id (used as `serverID` in `/sessions`). |
| `name`, `country`, `city` | string | Display. `city` optional. |
| `countryCode` | string | ISO 3166-1 alpha-2 (drives the flag emoji client-side). |
| `endpoint` | string | `host:port` of the WireGuard listener. |
| `publicKey` | string | Server's **public** WireGuard key, base64. |
| `load` | number? | 0.0–1.0. Drives "fastest" sort. Report it live if you can. |
| `isPremium` | bool | Gates the server behind IAP. |

Notes:
- Keep this endpoint cacheable/CDN-friendly; it changes slowly.
- Consider a `?tier=free|premium` or returning all and letting the client filter.
- If you ever add real "streaming" servers, add a `tags: ["streaming"]` field —
  the client currently fakes the streaming filter off `isPremium` (see the TODO
  in `ServerListViewModel`).

### 2.2 `POST /v1/sessions` — register device & negotiate tunnel  **(required, core)**

This is the endpoint with **no old-app equivalent** and the main work. The
device sends its freshly generated public key; the backend adds it as a peer on
the chosen node and returns everything needed to build the tunnel.

Client request model: `SessionRequest`; response: `SessionResponse`
(`App/Services/ServerRepository.swift`).

**Request:**
```json
{ "serverID": "de-fra-01", "publicKey": "CLIENT_WG_PUBLIC_KEY_BASE64=" }
```

**Response:**
```json
{
  "serverPublicKey": "SERVER_WG_PUBLIC_KEY_BASE64=",
  "endpoint": "de-fra-01.vpnmaster.net:51820",
  "assignedAddresses": ["10.7.0.23/32"],
  "dns": ["1.1.1.1", "1.0.0.1"],
  "presharedKey": "OPTIONAL_PSK_BASE64=",
  "quota": {
    "unlimited": false,
    "limitBytes": 1073741824,
    "usedBytes": 322122547,
    "remainingBytes": 751619277,
    "period": "monthly",
    "resetsAt": "2026-10-01T00:00:00Z"
  }
}
```
> `usedBytes` counts **RX + TX combined** for the device across all nodes this
> period. `remainingBytes` is what the node is programmed to allow before it cuts
> this peer off at the network level (§6.3).

Backend must, for the chosen node:
1. Validate `serverID` and (if premium) the caller's entitlement.
2. **Check the device's remaining quota** (§8). If exhausted, reject with `403`
   / `429` and a `quota` body instead of registering a peer.
3. **Allocate a unique tunnel IP** from that node's pool → `assignedAddresses`.
4. **Add the peer** to the node's WireGuard config:
   `wg set wg0 peer <publicKey> allowed-ips <assignedIP>/32 [preshared-key <psk>]`
   (persist so it survives node restarts).
5. Return the node's public key, endpoint, DNS, optional PSK, and the current
   `quota` snapshot so the app can show a data meter immediately.

> `quota` is optional in the payload only for **premium/unlimited** devices
> (send `{"unlimited": true}`); metered devices must always receive it.

Operational must-haves:
- **Idempotency / re-registration:** if the same device pubkey posts again,
  return its existing allocation instead of leaking a new IP each time.
- **IP pool exhaustion:** return `503`/`409` with a clear message when full.
- **PSK** (`presharedKey`) is optional but recommended (extra symmetric layer);
  the app already supports it end-to-end.

### 2.3 `POST /v1/sessions/close` (or `DELETE /v1/sessions/{id}`) — teardown  **(recommended)**

The app **does not call this yet** — add the call in `VPNService.disconnect()`
once the endpoint exists. Without it you must reap peers server-side (see §5).

```json
{ "serverID": "de-fra-01", "publicKey": "CLIENT_WG_PUBLIC_KEY_BASE64=" }
```
Backend runs `wg set wg0 peer <publicKey> remove` and frees the tunnel IP.

### 2.4 `POST /v1/devices` — device identity / token  **(recommended)**

The old app authed with one shared static key. That's fine to start, but to
rate-limit abuse, gate premium, and reap sessions you want a per-device identity.

```json
// request
{ "deviceId": "<vendor-id-or-random-uuid>", "platform": "ios", "appVersion": "1.0.0" }
// response
{ "token": "JWT_OR_OPAQUE", "expiresAt": "2026-10-01T00:00:00Z" }
```
Client then sends `Authorization: Bearer <token>` on `/sessions`. No email/login
needed — anonymous device auth keeps the "no account, no logs" promise the
onboarding copy makes.

### 2.5 `GET /v1/usage` — remaining data allowance  **(required if you meter free users)**

Lets the app show a live data meter and warn/stop before the tunnel is killed
mid-session. Cheap, pollable (e.g. on Home appear + every ~30–60s while
connected). Keyed off the device token / `X-API-Key`.

**Response:**
```json
{
  "unlimited": false,
  "limitBytes": 1073741824,
  "usedBytes": 322122547,
  "remainingBytes": 751619277,
  "period": "monthly",
  "resetsAt": "2026-10-01T00:00:00Z"
}
```
Same `quota` shape returned inside `/sessions`. Premium is a **separate, higher**
plan — either a bigger `limitBytes` or `{"unlimited": true}`.
This also feeds the real numbers for the Connection-info screen's
downloaded/uploaded fields (currently hardcoded in `ConnectionInfoViewModel`).

### 2.6 `POST /v1/purchases/validate` — IAP receipt check  **(later; when Premium ships)**

Premium is deferred in v1 but the model exists (`isPremium`). When it lands:
```json
// request
{ "receipt": "<app-store-jws-or-receipt>", "deviceId": "..." }
// response
{ "isPremium": true, "expiresAt": "2026-12-01T00:00:00Z", "productId": "..." }
```
Backend validates against Apple (StoreKit 2 JWS / App Store Server API) and, on
`/sessions`, allows `isPremium` servers only for entitled devices.

### 2.7 `GET /v1/config` — remote config  **(optional, nice-to-have)**

Your other apps use a remote-config/paywall-config pattern. Useful here for:
```json
{
  "termsUrl": "https://…/terms",
  "privacyUrl": "https://…/privacy",
  "minSupportedVersion": "1.0.0",
  "forceUpdate": false,
  "defaultDns": ["1.1.1.1", "1.0.0.1"],
  "freePlan":    { "limitBytes": 1073741824,  "period": "monthly" },
  "premiumPlan": { "limitBytes": 107374182400, "period": "monthly" }
}
```
Wires the currently-hardcoded Settings links (Terms/Privacy) and enables
force-update.

---

## 3. WireGuard node requirements (the actual VPN servers)

Distinct from the API. Each region/server in `/servers` is a real host running
`wireguard-go`/`wg`:

- A WireGuard interface (`wg0`) with a **server keypair**; the public half goes
  in the `/servers` list.
- A **tunnel subnet + IP pool** per node (e.g. `10.7.0.0/16`) that `/sessions`
  allocates from.
- **NAT/masquerade** out to the internet (`iptables MASQUERADE` / `nftables`).
- IP forwarding enabled; UDP `51820` (or your port) open.
- The control plane (`/sessions`) must be able to run `wg set` on the node —
  either the API runs on each node, or a small agent per node, or you drive `wg`
  over SSH/gRPC from a central API.
- **Load reporting:** each node reports peer count / CPU / bandwidth so
  `/servers.load` is real (drives "fastest").
- **Quota agent (see §6):** a small per-node agent that samples
  `wg show wg0 transfer`, reports per-peer RX+TX deltas to the control plane, and
  programs an in-kernel **nftables byte quota** per peer's tunnel IP so the node
  cuts traffic off at the allowance without waiting on the API.
- **DNS:** run a resolver or hand back public resolvers in `dns`.

---

## 4. Auth & security

- Ship a real per-environment **app key** (`X-API-Key`); rotate the leaked
  `ghp_…` style key — never reuse the old one.
- Prefer per-device **bearer tokens** (§2.4) over the shared key alone.
- The client's WireGuard **private key never leaves the device** — the backend
  only ever sees public keys. Do **not** replicate the old app's "encrypt
  credentials with a hardcoded key" scheme; it's unnecessary here and was only
  obfuscation.
- Rate-limit `/sessions` per device/IP.
- **Logging:** to keep the "no logs" promise, don't persist per-user traffic
  logs; peer allocations can be ephemeral.

---

## 5. Session lifecycle / reaping

Because a device can vanish without calling teardown (§2.3), the backend must not
leak peers/IPs:

- Give each peer a **TTL**; a periodic job removes peers idle past N minutes
  (WireGuard exposes `latest handshake` per peer — reap on stale handshake).
- On re-registration, reuse the device's existing allocation.
- Cap peers per node; when full, `/sessions` should fail over to another node or
  return a clear error.

---

## 6. Bandwidth limiting & quotas

Freemium model:

- **Free:** 1 GB / month, counting **RX + TX combined** per WireGuard peer.
- **Premium:** a separate, higher limit (e.g. 100 GB/month) or unlimited.
- Quota **resets monthly**; usage is tracked **per device** and enforced **at
  the network level on the VPN node** — see §6.3, the most important part.

Plans are served via `/config` (`freePlan` / `premiumPlan`) so you can tune them
without an app release.

### 6.1 Accounting (measuring usage)
- Source of truth is the node kernel: `wg show wg0 transfer` → `<pubkey> <rx>
  <tx>`. Usage = `rx + tx`.
- A per-node agent samples this on a short interval, computes the **delta** since
  its last sample per peer, and reports it to the central store, which adds it to
  that **device's** monthly counter. Always accumulate deltas — the raw counter
  resets when a peer is re-added or the node reboots.
- Track per **device**, not per peer/node: a device roams across regions within a
  month, so its 1 GB is the sum across every node it used.
- A monthly job (or a `resetsAt`-driven check) zeroes counters at the period
  boundary.

### 6.2 Central store (Node/Postgres) is the ledger, NOT the enforcer
Postgres holds the authoritative monthly total, does cross-node aggregation, and
decides plan/limit. But **do not rely on it to stop traffic.** The central store
only learns about usage when an agent reports in; between reports a user keeps
consuming. On a 1 GB cap a fast connection can blow past the limit in the seconds
between polls. Central polling is for *bookkeeping and the meter*, never the gate.

### 6.3 Enforcement MUST be on the VPN node, at the network layer  **(the key requirement)**

The node itself has to drop the peer's traffic the instant it hits its allowance,
with no round-trip to the API. Design:

1. **At connect (`POST /sessions`)** the control plane computes the device's
   **remaining** bytes this month (`limit − usedSoFar`) from Postgres and
   programs that allowance into the node **as it adds the peer**, so enforcement
   is armed before the first packet flows.
2. **The node enforces locally in the kernel.** Recommended: an **`nftables`
   quota** object bound to the peer's tunnel IP, e.g.

   ```
   # per-peer, drops once the byte budget is spent — enforced in-kernel
   table inet wgquota {
     set overlimit { type ipv4_addr; }
     chain forward {
       type filter hook forward priority 0;
       # count this peer's traffic against a byte quota; when exhausted, add to overlimit
       ip saddr 10.7.0.23 quota over 751619277 bytes drop
       ip daddr 10.7.0.23 quota over 751619277 bytes drop
     }
   }
   ```
   The kernel stops the traffic at the exact threshold — no API window. (An
   `iptables`+`quota`/`connbytes` equivalent works too; nftables `quota` is the
   cleanest.) Program the quota with the device's **remaining** allowance, not
   the full 1 GB, so a device that already used 700 MB elsewhere only gets 300 MB
   more here.
3. **Also drop the peer** once quota is hit (`wg set wg0 peer <pubkey> remove`)
   so the tunnel actually goes down and the app surfaces it, and free the IP.
4. **Refuse re-registration:** `POST /sessions` returns `403`/`429` + a `quota`
   body until `resetsAt`, so the user can't just reconnect for a fresh peer.
5. **Reconciliation:** when the node cuts a peer off (or on disconnect), the
   agent reports the final delta so Postgres's total matches reality; the small
   over-count from the last unreported sample is bounded because the kernel cap,
   not the poll, is what actually stopped traffic.

> Net: **Postgres decides the number, the node's kernel enforces it.** The API is
> never in the packet path.

*(Optional, later)* Instead of a hard cut you can **throttle** an over-limit free
peer with `tc` (HTB/`tbf` on its `allowed-ips`) so it slows to a trickle rather
than disconnecting.

### 6.4 How the app cooperates (UX only)
- Reads `quota` from `/sessions` and polls `/usage` while connected to show a
  meter and "X of 1 GB left this month".
- **Warns** near the cap; on a `403`/`429 quota-exceeded` from `/sessions`, shows
  an upsell ("Upgrade for more data") instead of a generic connection error; and
  when the tunnel drops mid-session on exhaustion, explains why.
- The app meter is convenience only — §6.3 is the real gate.

> **Minimum viable:** per-device monthly RX+TX counter (agent samples
> `wg show transfer`), 1 GB cap from `/config`, **node-level nftables quota
> programmed with remaining bytes at connect**, peer removed at the cap,
> `/sessions` refuses over-quota devices, `/usage` for the meter. Throttling,
> multi-region aggregation refinements, and premium tiers layer on top.

---

## 7. Values the app needs from you (checklist)

To go live, hand the iOS side:

1. **Base URLs** — staging + production (`APIConfiguration`).
2. **App key(s)** — per environment (`X-API-Key`).
3. **At least one working node** with: endpoint `host:port`, server public key,
   a `/servers` entry, and a `/sessions` that returns a real allocation.
4. **Terms & Privacy URLs** (for Settings + onboarding).
5. **Data caps** — free 1 GB/month (RX+TX) and the premium limit — served via
   `/config` (`freePlan` / `premiumPlan`), enforced per §6.3 on the node.
6. (Later) **StoreKit product ids** + receipt-validation endpoint for Premium.

---

## 8. Client changes implied by this spec

Tracked so the app and backend stay in sync:

- **Envelope:** if you pick the `AppResponse<T>` envelope (Option B, §1), update
  `ServerRepository`/`NetworkService` to unwrap `data`. Today they decode bare
  bodies (Option A).
- **Auth header:** inject `X-API-Key` (and optional `Authorization: Bearer`) via
  `APIConfiguration.defaultHeaders` — currently empty except `Accept`.
- **Teardown:** call `/sessions/close` from `VPNService.disconnect()` once §2.3
  exists.
- **DI fix:** `MainTabBarController` uses `MockServerRepository` for the list but
  the real `ServerRepository` for connect — unify these against the real API.
- **Default server:** persist/restore the selected server and default to fastest
  so a fresh launch can connect (see the app-side gap list).
- **Quota UI (new):** add a `Quota`/`Usage` model, a data meter on Home/
  Connection-info fed by `/usage`, a near-cap warning, and a quota-exceeded →
  upsell path when `/sessions` returns `403`/`429`. Wire the real byte counts
  into `ConnectionInfoViewModel` (currently hardcoded).
```
