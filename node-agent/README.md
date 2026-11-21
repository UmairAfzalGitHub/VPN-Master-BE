# VPN Master — Node Agent (strongSwan + FreeRADIUS)

Runs on each VPN node (Linux). strongSwan terminates the IKEv2/IPsec tunnel and
delegates EAP-MSCHAPv2 to a local **SQL-backed FreeRADIUS**; this agent manages the
per-connect EAP credentials and reports usage by talking to the RADIUS **database
only** — it never rewrites strongSwan config at runtime. The control plane on Render
drives it over HTTPS.

**To set up a node, follow [`../docs/RUNBOOK-add-server.md`](../docs/RUNBOOK-add-server.md)**
(it has every command, in order, with the verification for each step). This file is the
reference for the agent itself.

## Contract

Auth: `X-Agent-Secret: <AGENT_SECRET>` on every request (must equal
`NODE_AGENT_SECRET` on the control plane).

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST   | `/credentials` | `{ username, password, remainingBytes?, expiresAt? }` | upsert the EAP user; remember its quota/expiry for the sweep |
| DELETE | `/credentials` | `{ username }` | delete the EAP user + RADIUS Disconnect (drops the live session) |
| GET    | `/accounting`  | — | `{ sessions: [{ username, rxBytes, txBytes, lastSeen, assignedIp }] }` |

- `remainingBytes: null` ⇒ unlimited (no byte enforcement). `expiresAt` is ISO-8601.
- `/accounting` sums a username's `radacct` rows (a reconnect makes a second row),
  `lastSeen` is unix seconds, `assignedIp` is the latest virtual IP without a `/32`.
- The control plane's `services/provisioner/agent.js` is the only caller.

## Node stack

```
client ──IKEv2/IPsec (UDP 500/4500)──▶ strongSwan ──EAP-RADIUS──▶ FreeRADIUS ──▶ Postgres (radcheck / radacct)
                                           ▲  Disconnect (DAE, 127.0.0.1:3799)            ▲
                                           └──────────── this agent (HTTPS :8443) ────────┘
```

Packages: `strongswan-swanctl charon-systemd libcharon-extra-plugins
libstrongswan-extra-plugins freeradius freeradius-postgresql freeradius-utils postgresql
certbot nodejs npm`. **`freeradius-utils` provides `radclient`** — without it
disconnects silently do nothing.

## Configuration (environment)

Set through `EnvironmentFile=/etc/ikev2-node/agent.env` (root-only, `0600`), unquoted values.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_SECRET` | — (required) | shared secret; = Render's `NODE_AGENT_SECRET` |
| `RADIUS_DATABASE_URL` | — (required) | Postgres URL for the **`vpnagent`** role (read `radacct`, write `radcheck` — nothing else) |
| `DAE_SERVER` | `127.0.0.1:3799` | strongSwan's RADIUS Disconnect listener |
| `DAE_SECRET` | — | must equal `dae { secret }` in `/etc/strongswan.d/zz-vpn.conf`. Unset ⇒ disconnects are skipped |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | — | when both set: HTTPS on `AGENT_TLS_PORT`, plain HTTP bound to `127.0.0.1` only |
| `AGENT_TLS_PORT` / `AGENT_PORT` | `8443` / `8080` | |
| `IKEV2_SWEEP_INTERVAL_MS` | `15000` | how often the sweep checks quota/expiry (the runbook sets `5000`) |
| `AGENT_STATE_FILE` | `/var/lib/vpn-agent-ikev2/creds.json` | per-credential quota/expiry, `0600`, survives restarts |
| `RADIUS_PGSSL` | — | `true` to use TLS to Postgres (not needed on localhost) |

The disconnect listener lives **in strongSwan** (`eap-radius { dae { … } }`), not in
FreeRADIUS.

## How quota and expiry are enforced

IKEv2 has no in-kernel per-flow byte cutoff, so the cap is enforced from RADIUS
accounting, in two layers:

- **This agent (fast path):** every `IKEV2_SWEEP_INTERVAL_MS` it compares each tracked
  credential's `radacct` bytes to its `remainingBytes`, and `expiresAt` to now. On a breach
  it deletes the RADIUS user and sends a Disconnect, which strongSwan acknowledges and acts on.
- **Control plane (backstop):** the usage poller turns `/accounting` into the monthly
  ledger and revokes a device's credentials once the ledger shows it exhausted.

Latency is the accounting interval (`accounting_interval = 15` s in strongSwan) plus the
sweep — not instantaneous. At very high speed a session can pass its cap by roughly
speed × ~20 s (at the original 60 s interval a speed test overshot a 200 MB cap by
~180 MB). An exact byte cap would need a per-virtual-IP `nftables` quota (not built).

An **expired** credential is also disconnected, so a session ends when its credential's
TTL (`IKEV2_CRED_TTL_SECONDS`, default 24 h, set on the control plane) passes. The strongSwan
connection sets `reauth_time = 0s` so EAP is never re-run mid-session.

## Security notes

- No shell anywhere: RADIUS access is parameterised `pg` queries; `radclient` is run with
  `execFileSync` (no shell), the username on **stdin**, and usernames are validated to
  `[A-Za-z0-9_.-]{1,64}`, passwords to `[A-Za-z0-9_-]{1,128}`.
- Runs as the non-root `vpnagent` user; the agent's DB role can't touch other tables.
- The EAP password is stored cleartext in `radcheck` (MSCHAPv2 needs it); credentials are
  short-lived and per-connect, and the row is deleted on close/expiry/quota.
- `radclient` takes the disconnect secret as an argument, so the agent **redacts it** from
  its own log lines.
- TLS: a self-signed cert whose SAN is the node's IP, pinned by the control plane from
  `certs/<id>-agent.crt`. `X-Agent-Secret` authenticates the caller.
- Firewall: `:8443` is open to **Render's outbound ranges only**; `:8080` is loopback-only.
  If Render's ranges change, the firewall drops the control plane *silently* (symptoms:
  usage stops advancing, `/v1/sessions` → "Could not reach the VPN node"; diagnose with the
  `tcpdump` snippet in the runbook).

## Service unit (`/etc/systemd/system/vpn-agent-ikev2.service`)

See the runbook (§A7). Key points: `User=vpnagent`, `EnvironmentFile=/etc/ikev2-node/agent.env`,
`StateDirectory=vpn-agent-ikev2`, `Restart=always`.

## Smoke test (on the node)

The full verified sequence is in the runbook (§A7 "Verify the agent"). In short:

```bash
SEC=$(grep ^AGENT_SECRET= /etc/ikev2-node/agent.env | cut -d= -f2-)
curl -s --cacert /opt/vpn-agent-ikev2/agent.crt -H "X-Agent-Secret: $SEC" https://127.0.0.1:8443/accounting
```
