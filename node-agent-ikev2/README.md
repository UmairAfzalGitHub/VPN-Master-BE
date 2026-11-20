# VPN Master — IKEv2/IPsec Node Agent (strongSwan + FreeRADIUS)

Runs on each IKEv2 node (Linux). The IKEv2 analogue of `../node-agent` (the
WireGuard agent). strongSwan terminates the tunnel and delegates EAP-MSCHAPv2 to
a local **SQL-backed FreeRADIUS**; this agent manages EAP credentials and reads
usage by talking to the RADIUS database only — it never rewrites strongSwan
config at runtime. The control plane on Render drives it over HTTP. See
`index.js` for the contract and `../docs/IKEV2-MIGRATION.md` for the big picture.

## Contract

Auth: `X-Agent-Secret: <AGENT_SECRET>` on every request (must equal
`NODE_AGENT_SECRET` on the control plane).

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST   | `/credentials` | `{ username, password, remainingBytes?, expiresAt? }` | upsert EAP user; record quota/expiry for the sweep |
| DELETE | `/credentials` | `{ username }` | delete EAP user + CoA-disconnect the live SA |
| GET    | `/accounting`  | — | `{ sessions: [{ username, rxBytes, txBytes, lastSeen, assignedIp }] }` |

The server row for this node sets `provisioner = 'ikev2'`, `protocol = 'ikev2'`,
and `agent_url` to this agent (the control plane's `services/provisioner/ikev2Agent.js`).

## Node stack

```
client ──IKEv2/IPsec (UDP 500/4500)──> strongSwan ──EAP-RADIUS──> FreeRADIUS ──> Postgres (radcheck/radacct)
                                              ▲                                        ▲
                                     DAE/CoA (3799)                          this agent (HTTP 8443)
```

Install (Debian/Ubuntu):

```bash
apt-get update
apt-get install -y strongswan strongswan-swanctl libcharon-extra-plugins \
                   freeradius freeradius-postgresql postgresql nftables nodejs npm
cd /opt/vpn-agent-ikev2 && npm i express pg      # agent deps
```

The agent runs as a non-root service user that can reach Postgres and run
`radclient`; unlike the WireGuard agent it does **not** need root (it never
touches `wg`/`nft`).

### FreeRADIUS (SQL + accounting + DAE)

1. Enable the `sql` module (`freeradius-postgresql`), point it at a Postgres DB,
   and load the standard schema (ships with the package):
   ```bash
   psql -U radius -d radius -f /etc/freeradius/3.0/mods-config/sql/main/postgresql/schema.sql
   ```
   This creates `radcheck` (what the agent upserts) and `radacct` (what
   `/accounting` reads). Enable `sql` in both `authorize` and `accounting`
   sections and symlink `mods-enabled/sql`.
2. Give the **agent** its own Postgres role with access to `radcheck` + `radacct`
   and set `RADIUS_DATABASE_URL` to it (below).
3. Enable **DAE** (Dynamic Authorization) so the agent can disconnect a live SA:
   in `sites-enabled`, enable the `coa`/`dynamic-clients` listener on `3799` and
   add a client for `127.0.0.1` with a shared secret (`DAE_SECRET`).

### strongSwan (`/etc/swanctl/conf.d/vpnmaster.conf`)

EAP-MSCHAPv2 with the server authenticating by certificate, clients by RADIUS:

```
connections {
  ikev2-eap {
    version = 2
    pools = vip_pool                       # virtual IPs == servers.tunnel_subnet
    local {
      auth = pubkey
      certs = node.crt                     # SAN == servers.ike_remote_id
      id = %any
    }
    remote {
      auth = eap-radius                    # delegate to FreeRADIUS
      eap_id = %any
    }
    rekey_time = 0                          # see "Connect-gate & reauth" below
    reauth_time = 0                         # reauth=no — don't re-run EAP mid-session
    send_cert = always
    children { ikev2-eap { ... } }
  }
}
pools { vip_pool { addrs = 10.20.0.0/16; dns = 1.1.1.1, 1.0.0.1 } }
```

Enable the `eap-radius` plugin with accounting + DAE pointed at FreeRADIUS. The
node certificate's SAN must equal the server row's `ike_remote_id` (the client
validates it); ship the issuing CA to the apps (bundled) or via `servers.ca_cert`.

### Connect-gate & reauth (important)

The connect-gate (`docs/IKEV2-MIGRATION.md` §6) is the credential TTL
(`IKEV2_CRED_TTL_SECONDS` on the control plane; the agent gets `expiresAt`). For
a **tight** gate, strongSwan must be configured with `reauth_time = 0`
(**reauth=no**) so EAP only runs at initial connect — otherwise an IKE reauth
re-checks the credential mid-session and a short TTL would drop a live tunnel.
With reauth off, the agent can safely expire/revoke a credential right after the
session is up without killing the active SA, making the gate close to single-use.

## systemd unit (`/etc/systemd/system/vpn-agent-ikev2.service`)

```ini
[Unit]
Description=VPN Master IKEv2 Node Agent
After=network.target freeradius.service strongswan.service

[Service]
Type=simple
User=vpnagent
WorkingDirectory=/opt/vpn-agent-ikev2
Environment=AGENT_SECRET=<same value as NODE_AGENT_SECRET on Render>
Environment=RADIUS_DATABASE_URL=postgres://agent:<pw>@127.0.0.1:5432/radius
Environment=DAE_SERVER=127.0.0.1:3799
Environment=DAE_SECRET=<FreeRADIUS DAE client secret>
# optional: Environment=AGENT_PORT=8080  Environment=IKEV2_SWEEP_INTERVAL_MS=15000
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Values are unquoted on purpose — systemd treats quotes as part of the value.

## Enforcement model

IKEv2 has **no** in-kernel per-flow byte cutoff like WireGuard's nftables quota,
so enforcement is two-layered (`docs/IKEV2-MIGRATION.md` §4, option 1):

- **Control plane:** the usage poller ingests `/accounting` into the ledger and,
  when a device is exhausted, calls `DELETE /credentials` (which CoA-disconnects).
- **Node-side sweep (this agent):** every `IKEV2_SWEEP_INTERVAL_MS` (default 15s)
  it checks each tracked credential's RADIUS accounting against `remainingBytes`
  and its `expiresAt`, and on breach deletes the RADIUS user + sends a DAE
  Disconnect. This drops over-quota/expired sessions promptly instead of waiting
  for the ~60s control-plane poll.

Enforcement latency is therefore the sweep interval, not instantaneous as on
WireGuard — acceptable for a monthly data cap. `remainingBytes: null` (premium)
⇒ no byte enforcement.

### State & restart

The quota/expiry the sweep needs per credential is mirrored to
`AGENT_STATE_FILE` (default `/var/lib/vpn-agent-ikev2/creds.json`, `0600`) so an
agent restart doesn't forget enforcement. The credential itself lives in RADIUS
(`radcheck`), which is authoritative. `radacct` rows accumulate; prune old
accounting with FreeRADIUS housekeeping (`sql` cleanup / a cron), independent of
this agent.

## TLS & firewall

Identical scheme to the WireGuard agent (`../node-agent/README.md`): set
`TLS_CERT_FILE` + `TLS_KEY_FILE` to serve HTTPS on `AGENT_TLS_PORT` (8443, all
interfaces) and bind plain HTTP to `127.0.0.1`. Commit the node's **public**
agent cert to `../certs/` so the control plane trusts it (via
`services/provisioner/nodeHttp.js`), exactly as for WireGuard nodes. Open 8443 to
Render's outbound ranges only; open **UDP 500 and 4500** (IKE + NAT-T) to the
world. The agent's own port must never be world-reachable.

## Hardening notes

- No shell anywhere: RADIUS access is parameterized `pg` queries; `radclient`
  (DAE) is `execFileSync` with the username passed on **stdin**, and usernames
  are validated to `[A-Za-z0-9_.-]{1,64}` — no injection surface.
- The agent needs no root (no `wg`/`nft`); run it as a dedicated service user.
- `X-Agent-Secret` authenticates every call; TLS adds encryption + server auth
  over the Render↔node transit.
- DAE is best-effort: if it's not configured, credential deletion + the control
  plane still tear sessions down, just less promptly.

## Smoke test (on the node)

```bash
SECRET=<AGENT_SECRET>
# add a credential
curl -s -X POST http://127.0.0.1:8080/credentials -H "X-Agent-Secret: $SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"username":"u_test01","password":"testpass","remainingBytes":5242880,"expiresAt":"2030-01-01T00:00:00Z"}'
# confirm it's in RADIUS
psql -U radius -d radius -c "select username,attribute from radcheck where username='u_test01';"
# connect a real IKEv2 client with u_test01 / testpass, then read usage
curl -s http://127.0.0.1:8080/accounting -H "X-Agent-Secret: $SECRET"
# remove it (drops the live SA via DAE)
curl -s -X DELETE http://127.0.0.1:8080/credentials -H "X-Agent-Secret: $SECRET" \
  -H 'Content-Type: application/json' -d '{"username":"u_test01"}'
```
