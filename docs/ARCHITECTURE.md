# VPN Master — System Architecture

How the whole thing fits together, end to end: the **iOS app**, the **control
plane** (this repo, on Render), the **Postgres ledger**, and the **WireGuard
node** (a DigitalOcean droplet). This is the "how it actually works now" doc —
refer to it when you come back to the project.

> Diagrams are [Mermaid](https://mermaid.js.org/) and render on GitHub.

---

## 1. The three planes

There are three independent pieces. The golden rule: **your VPN traffic never
touches Render.** Render is only the coordinator; the encrypted tunnel is
phone ⇆ droplet.

```mermaid
flowchart TB
    subgraph Phone["📱 iPhone — VPNMasteriOS"]
        App["App UI · ServerRepository · VPNService"]
        Ext["PacketTunnel extension<br/>(WireGuardKit / wireguard-go)"]
    end

    subgraph Render["☁️ Render — Control Plane (this repo)"]
        API["Node/Express API<br/>nyx-edge.onrender.com"]
        DB[("Postgres<br/>servers · devices · peers · usage")]
        Jobs["Background jobs<br/>usage poller · reaper"]
        API --- DB
        Jobs --- DB
    end

    subgraph Droplet["🖥️ DigitalOcean droplet — 192.34.58.185"]
        Agent["Node agent<br/>:8080 (HTTP)"]
        WG["wg0 interface<br/>UDP :51820 · subnet 10.8.0.0/16"]
        NAT["NAT / masquerade → internet"]
        Agent -->|wg set / wg show| WG
        WG --> NAT
    end

    Internet(("🌐 Internet"))

    App -->|"HTTPS + X-API-Key<br/>(setup calls only)"| API
    API -->|"HTTP + X-Agent-Secret<br/>program / remove peer"| Agent
    Jobs -->|"GET /metrics<br/>(poll RX+TX)"| Agent
    Ext ==>|"encrypted WireGuard tunnel<br/>(UDP 51820) — the actual VPN"| WG
    NAT --> Internet
```

**Control path** (thin, occasional HTTPS): the app asks the API for the server
list and to register a session. **Data path** (the real VPN): the phone builds a
WireGuard tunnel straight to the droplet and its traffic exits to the internet
from there. The API is never in the packet path.

---

## 2. What each piece is

| Piece | Where | Role |
|---|---|---|
| **iOS app** | iPhone | UI + `ServerRepository` (catalog/session) + `VPNService` → `TunnelManager` (system VPN) |
| **PacketTunnel extension** | iPhone (separate process) | Runs `wireguard-go`, holds the private key, moves packets |
| **Control plane API** | Render (`nyx-edge.onrender.com`) | `/v1/*` endpoints; the only thing the app talks to over HTTPS |
| **Postgres** | Render (`vpn-master-db`) | Authoritative store: servers, devices, peers, monthly usage ledger |
| **Usage poller + reaper** | Render (in-process jobs) | Pulls `/metrics` from nodes → ledger; removes stale peers |
| **Node agent** | Droplet (`:8080`) | Only thing that runs `wg`; programs/removes peers, reports transfer |
| **WireGuard (`wg0`)** | Droplet (`UDP :51820`) | Terminates the tunnel, NATs traffic out to the internet |

---

## 3. Connecting — the full sequence

This is exactly what happens when you tap **Connect** (verified live).

```mermaid
sequenceDiagram
    autonumber
    participant App as 📱 App (VPNService)
    participant API as ☁️ nyx-edge /v1
    participant DB as 🗄️ Postgres
    participant Agent as 🖥️ Node agent :8080
    participant WG as 🔒 wg0 :51820

    App->>App: generate WireGuard keypair<br/>(private key never leaves device)
    App->>API: POST /v1/sessions<br/>{ serverID, publicKey }  (X-API-Key)
    API->>DB: resolve device, check premium + quota
    alt quota exhausted
        API-->>App: 403 { error, quota }  → upsell
    else ok
        API->>DB: allocate free tunnel IP (10.8.0.x)<br/>insert peer (idempotent per server+pubkey)
        API->>Agent: POST /peers<br/>{ publicKey, assignedIp, presharedKey, remainingBytes }<br/>(X-Agent-Secret)
        Agent->>WG: wg set wg0 peer … allowed-ips 10.8.0.x/32 preshared-key …
        Agent-->>API: { success: true }
        API-->>App: 200 { serverPublicKey, endpoint,<br/>assignedAddresses, dns, presharedKey, quota }
    end

    App->>App: build WireGuardConfiguration
    App->>WG: install profile → startVPNTunnel()<br/>Noise handshake to 192.34.58.185:51820
    WG-->>App: handshake complete → status: connected
    Note over App,WG: traffic now flows phone ⇆ droplet ⇆ internet
```

Key points:
- The device sends only its **public** key; the private key stays on the phone.
- The IP allocation is transaction-locked so two connects can't grab the same IP.
- Re-registering the same public key returns the **existing** allocation (no leak).
- A preshared key (PSK) is generated per session for an extra symmetric layer.

---

## 4. Quota / metering loop

Postgres is the **ledger** (the authoritative monthly RX+TX total per device);
the node is where traffic actually happens. They're reconciled by polling.

```mermaid
sequenceDiagram
    autonumber
    participant WG as 🔒 wg0 (kernel counters)
    participant Agent as 🖥️ Node agent
    participant Poll as ☁️ Usage poller (every 60s)
    participant DB as 🗄️ usage_counters
    participant App as 📱 App

    loop every ~60s
        Poll->>Agent: GET /metrics (X-Agent-Secret)
        Agent->>WG: wg show wg0 dump
        WG-->>Agent: per-peer rx, tx, latestHandshake
        Agent-->>Poll: { peers: [{ publicKey, rxBytes, txBytes, lastHandshake }] }
        Poll->>DB: add (Δrx + Δtx) to device's monthly counter<br/>(reset-tolerant), refresh last_handshake_at
    end

    App->>App: GET /v1/usage → { usedBytes, remainingBytes, resetsAt }
```

- **Deltas, not absolutes:** the poller stores each peer's last raw reading and
  adds the difference, so counter resets (peer re-add / reboot) don't double-count.
- **Per device, across nodes:** usage is summed per device for the whole month,
  even if it roams between regions.
- **Free plan:** 1 GB/month (RX+TX combined). Served via `/v1/config`.
- ⚠️ **Not yet built:** in-kernel `nftables` enforcement (BACKEND.md §6.3). Today
  quota is *bookkeeping* — the ledger counts and `/sessions` refuses over-quota
  devices, but the node doesn't yet hard-cut traffic mid-session.

---

## 5. Session teardown & reaping

A device can vanish without a clean disconnect, so peers don't leak:

- **Explicit:** `POST /v1/sessions/close` → agent `DELETE /peers` → frees the IP.
- **Automatic:** the **reaper** removes peers whose last handshake is older than
  `PEER_TTL_MINUTES` (default 30), via the same `DELETE /peers`.

---

## 6. HTTP API (control plane)

All under `https://nyx-edge.onrender.com/v1`, all require `X-API-Key`.
Responses are **bare JSON** (no envelope) and **camelCase**.

| Method | Path | Purpose |
|---|---|---|
| GET  | `/servers` | Server catalog (`?tier=free\|premium`) |
| POST | `/sessions` | Register device pubkey as a peer; returns tunnel params + `quota` |
| POST | `/sessions/close` | Teardown: remove peer, free IP |
| POST | `/devices` | Anonymous device identity → `{ token, expiresAt }` |
| GET  | `/usage` | Current `quota` for a device (bearer token / `?deviceId` / `?publicKey`) |
| GET  | `/config` | Terms/privacy URLs, min version, DNS, plans |

**Internal (node agents only, header `X-Node-Secret`):**

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/nodes/:serverId/report` | Push-style usage report (alt to the poller) |

**Node agent API (on the droplet, header `X-Agent-Secret`):**

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST   | `/peers` | `{ publicKey, assignedIp, presharedKey?, remainingBytes? }` | add/refresh peer |
| DELETE | `/peers` | `{ publicKey }` | remove peer |
| GET    | `/metrics` | — | `{ peers: [{ publicKey, rxBytes, txBytes, lastHandshake }] }` |

---

## 7. Data model (Postgres)

```mermaid
erDiagram
    servers ||--o{ peers : hosts
    devices ||--o{ peers : owns
    devices ||--o{ usage_counters : accrues

    servers {
        text id PK
        text endpoint
        text public_key
        text tunnel_subnet
        text provisioner "mock | agent"
        text agent_url
        bool is_premium
        bool enabled
    }
    devices {
        uuid id PK
        text device_id "vendor id / null"
        bool is_premium
        timestamptz premium_expires_at
    }
    peers {
        uuid id PK
        uuid device_id FK
        text server_id FK
        text public_key
        text assigned_ip
        text preshared_key
        timestamptz last_handshake_at
        bigint last_sample_rx
        bigint last_sample_tx
    }
    usage_counters {
        uuid device_id FK
        date period_start
        bigint used_bytes
    }
```

- `peers` is unique per `(server_id, public_key)` and `(server_id, assigned_ip)`.
- `usage_counters` is keyed `(device_id, period_start)` — one row per device per month.

---

## 8. Security & secrets

| Secret | Lives in | Guards |
|---|---|---|
| `X-API-Key` (`API_KEYS`) | app binary + Render env | every `/v1/*` request |
| `X-Agent-Secret` (`NODE_AGENT_SECRET` / droplet `AGENT_SECRET`) | Render env + droplet unit | control plane ⇆ node agent |
| `JWT_SECRET` | Render env | signs device bearer tokens |
| WireGuard **private** keys | never leave their device/node | the tunnel itself |

- The client's WireGuard private key **never leaves the phone**; the backend
  only ever sees public keys.
- The hostname is deliberately **neutral** (`nyx-edge`, no "vpn") — networks
  that do SNI-based DPI reset TLS to "vpn"-looking hostnames. This bit us during
  bring-up; the neutral name evades it.
- ⚠️ The agent link is **plain HTTP** today (`agent_url = http://…:8080`), so
  `X-Agent-Secret` travels unencrypted. Fine for a test node; put the agent
  behind HTTPS (or a private network) before production, and lock `:8080` down.

---

## 9. Ports & networking (droplet)

| Port | Proto | Who | Purpose |
|---|---|---|---|
| 51820 | UDP | the world | WireGuard tunnel (data path) |
| 8080  | TCP | control plane (ideally locked to Render) | node agent (control path) |
| 22    | TCP | you | SSH admin |

Plus: IP forwarding enabled, NAT/masquerade from `10.8.0.0/16` out to the
internet, and peers persisted via `wg-quick save` so they survive a reboot.

---

## 10. Current status

**Working & verified live**
- ✅ App → control plane → node → real WireGuard tunnel (handshake + traffic)
- ✅ Per-device monthly RX+TX ledger, updated from real node metrics
- ✅ Server catalog, session negotiation with PSK, IP allocation, reaping
- ✅ Neutral hostname, cold-start retry resilience, full request/response logging

**Pending (all optional polish)**
- 🔲 Live `/usage` polling in the app (meter that ticks while connected)
- 🔲 `nftables` byte-quota enforcement on the node (hard cut at the cap)
- 🔲 Device tokens adopted client-side (quota per-device, not per-keypair)
- 🔲 IAP receipt validation for Premium
- 🔲 Trim the 3 placeholder servers (only `us-nyc-01` is a real node)
- ✅ Render on a paid tier — web service + Postgres both paid (no cold starts,
  Postgres persists); agent behind HTTPS (`us-nyc-01` on `https://…:8443`)

See `BACKEND.md` for the full spec and `README.md` for run/deploy details.
