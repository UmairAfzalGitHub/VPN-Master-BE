# Runbook — Adding a New WireGuard Server

A complete, copy-paste-able guide to add a new VPN region (a real WireGuard
node) to VPN Master. Written from the real bring-up of **`de-fra-01`
(Frankfurt)** — every command here was actually run.

> **Who this is for:** you, months from now, adding London or Singapore and
> having forgotten every detail. Follow it top to bottom; don't skip the
> verification or the gotchas.

---

## 0. The mental model (read this first)

There are **three planes**. Adding a server touches two of them:

```
📱 iPhone ──HTTPS──▶ ☁️ Control plane (this repo, on Render)  ──HTTPS/TLS──▶ 🖥️ Droplet (the node)
                     nyx-edge.onrender.com                                    agent :8443 + wg0 :51820
   │                                                                              ▲
   └──────────────── encrypted WireGuard tunnel (UDP 51820) ─────────────────────┘
                     THE ACTUAL VPN — never touches Render
```

- **Control plane** (Render) — owns the Postgres `servers` catalog, allocates
  tunnel IPs, and drives each node's agent over TLS. Never carries VPN traffic.
- **The node** (a DigitalOcean droplet) — runs WireGuard (`wg0`) + the
  **node-agent** (`node-agent/index.js`) on `:8443` HTTPS. This is the real VPN.
- **The phone** — builds the encrypted tunnel straight to the droplet.

**Adding a server = stand up a new droplet exactly like an existing one, then
register it in Postgres with a migration.** That's it.

### The work splits in two halves

- **Half A — the droplet** (steps A1–A8): SSH work on a brand-new Linux host.
- **Half B — the control plane** (steps B1–B4): a migration + a committed cert
  in this repo, then a push to deploy.

---

## 1. Before you start — the values you'll need and where they live

| Value | What it is | Where to get it | Where it goes |
|---|---|---|---|
| **SSH key** | Your DigitalOcean SSH private key | `~/.ssh/digitalocean_vpn_master` on your Mac | Every `ssh`/`scp` to the droplet |
| **`NODE_AGENT_SECRET`** | Shared secret between control plane and every agent | Render → VPN-Master-BE → Environment → `NODE_AGENT_SECRET` | The droplet's systemd unit (`AGENT_SECRET=`). **Same value on every node.** |
| **`API_KEYS`** (app key) | The `X-API-Key` the app + your curl tests send | Render → VPN-Master-BE → Environment → `API_KEYS` | Only used in your verification curls. Not on the droplet. |
| **Node WireGuard public key** | The node's WG public key (you generate it in A3) | Output of `cat server.pub` on the droplet | The Postgres `servers` row (`public_key`) |
| **Node IP** | The droplet's public IP | DigitalOcean dashboard when you create it | `endpoint`, `agent_url`, the TLS cert SAN, ufw |
| **Tunnel subnet** | The node's private IP pool (must be UNIQUE per node) | Pick the next free one — see §2 | `wg0.conf` Address + the Postgres row |

**The three things that MUST be unique per node:** the **IP**, the **WireGuard
keypair**, and the **tunnel subnet**. Everything else (the agent secret, the app
key, the agent code) is shared/identical across nodes.

**Control-plane primary URL:** `https://nyx-edge.onrender.com` — the hostname is
deliberately neutral (no "vpn") to dodge SNI-based DPI. It is **not**
`vpn-master-be.onrender.com` (that doesn't resolve).

---

## 2. Subnet registry — pick the next free one (CRITICAL)

Every node needs its own `10.x.0.0/16`. **Never reuse a subnet** — overlapping
pools would collide tunnel IPs across nodes.

| Subnet | Node |
|---|---|
| `10.8.0.0/16` | `us-nyc-01` (New York) |
| `10.11.0.0/16` | `de-fra-01` (Frankfurt) |
| `10.12.0.0/16` | `sg-sin-01` (Singapore) |
| `10.13.0.0/16` | `gb-lon-01` (London) |
| `10.14.0.0/16` | `ca-tor-01` (Toronto) — coming soon |
| `10.15.0.0/16` | `nl-ams-01` (Amsterdam) — coming soon |
| `10.16.0.0/16` | `au-syd-01` (Sydney) — coming soon |
| `10.17.0.0/16` | `us-sfo-01` (San Francisco) — coming soon |
| `10.18.0.0/16` | ← next free — use this for your new node |

> **When you add a node, update this table** in the same commit as the
> migration, so the next person doesn't reuse your subnet.

Throughout this runbook the **worked example** uses placeholders you replace:

| Placeholder | Example (Frankfurt) | Yours |
|---|---|---|
| `<SERVER_ID>` | `de-fra-01` | e.g. `gb-lon-01` |
| `<NODE_IP>` | `164.90.168.100` | your droplet IP |
| `<SUBNET>` | `10.11.0.0/16` | next free from §2 |
| `<SUBNET_GW>` | `10.11.0.1/16` | `.1` of your subnet |
| `<CN>` | `vpn-agent-de-fra-01` | `vpn-agent-<SERVER_ID>` |

---

# HALF A — Stand up the droplet

## A1. Create the droplet  *(DigitalOcean dashboard, or `doctl`)*

**Dashboard (recommended):** <https://cloud.digitalocean.com/droplets/new>
- **Region:** the city you're adding (e.g. Frankfurt → `de-fra-01`).
- **Image:** Ubuntu 24.04 LTS.
- **Size:** the smallest Basic/Regular ($4–6/mo) — WireGuard is light.
- **Authentication:** SSH key → select your `digitalocean_vpn_master` key.
- Create it, then **copy the public IP** → this is `<NODE_IP>`.

**CLI alternative (`doctl`):**
```bash
# ON YOUR MAC
brew install doctl && doctl auth init            # paste a DO API token
doctl compute ssh-key list                       # note your key's fingerprint
doctl compute region list                        # e.g. fra1, lon1, sgp1
doctl compute droplet create <SERVER_ID> \
  --region fra1 --image ubuntu-24-04-x64 --size s-1vcpu-1gb \
  --ssh-keys <FINGERPRINT> --wait
```

Confirm you can get in (accepts the host key the first time):
```bash
# ON YOUR MAC
ssh -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP>
```

---

## A2. Base packages + IP forwarding  *(ON THE DROPLET)*

```bash
# ON THE DROPLET
apt-get update && apt-get install -y wireguard nftables nodejs npm
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-wg.conf && sysctl --system
```

`net.ipv4.ip_forward=1` is what lets the box route tunnel traffic out to the
internet. `sysctl --system` applies it immediately and it persists across reboot.

---

## A3. WireGuard keypair + `wg0` interface  *(ON THE DROPLET)*

**Generate the keypair:**
```bash
# ON THE DROPLET
cd /etc/wireguard
umask 077
wg genkey | tee server.key | wg pubkey > server.pub
cat server.pub
```
👉 **Save the `cat server.pub` output** — it's the node's WireGuard **public**
key and goes in the Postgres row (`public_key`) in Half B. The **private** key
(`server.key`) never leaves the droplet.

**Find your network interface** (almost always `eth0`):
```bash
# ON THE DROPLET
ip route | grep default        # look at the word after "dev" — e.g. eth0
```
If it's not `eth0`, substitute your interface name in the config below.

**Write `wg0.conf`** — this exact PostUp/PostDown is what the working nodes use.
The two `iptables` rules are essential:
- `iptables -I FORWARD 1 -i wg0 -j ACCEPT` — allows tunnel traffic to be
  forwarded (inserted at the **top** so it beats ufw's default-DROP forward
  policy — see the gotcha in §T2).
- `iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE` — NATs tunnel traffic
  out to the internet.

```bash
# ON THE DROPLET — this reads server.key and writes the file in one shot
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = <SUBNET_GW>
PostUp = iptables -I FORWARD 1 -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
ListenPort = 51820
PrivateKey = $(cat /etc/wireguard/server.key)
EOF
```
> Replace `<SUBNET_GW>` with `.1` of your subnet, e.g. `10.12.0.1/16`. Keep the
> `/16`. If your interface isn't `eth0`, change both `eth0` references.

**Bring it up and enable on boot:**
```bash
# ON THE DROPLET
systemctl enable --now wg-quick@wg0
wg show                                  # expect: interface wg0, listening port 51820, your pubkey
iptables -L FORWARD -n -v --line-numbers | head -3   # rule #1 should be: ACCEPT ... in wg0
iptables -t nat -L POSTROUTING -n -v | grep -i masq  # expect a MASQUERADE line on eth0
```

---

## A4. Deploy the node-agent code  *(FROM YOUR MAC — it lives in this repo)*

The agent is `node-agent/index.js` in this repo. Copy it to the droplet and
install its one dependency:

```bash
# ON YOUR MAC, from the repo root
ssh -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP> 'mkdir -p /opt/vpn-agent'
scp -i ~/.ssh/digitalocean_vpn_master node-agent/index.js root@<NODE_IP>:/opt/vpn-agent/index.js
ssh -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP> 'cd /opt/vpn-agent && npm i express'
```

> When you later change the agent, re-run the `scp` line +
> `ssh … 'systemctl restart vpn-agent'`.

---

## A5. TLS cert for the agent  *(ON THE DROPLET, then pull to your Mac)*

The agent serves HTTPS with a **self-signed cert whose SAN is the node's IP** (no
domain, no Let's Encrypt needed). The control plane trusts it by shipping the
**public** cert in this repo (`certs/`).

**Generate on the droplet** (10-year expiry, EC key, IP-SAN pinned to the node):
```bash
# ON THE DROPLET
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout /opt/vpn-agent/agent.key -out /opt/vpn-agent/agent.crt -days 3650 \
  -subj "/CN=<CN>" -addext "subjectAltName=IP:<NODE_IP>,IP:127.0.0.1"
chmod 600 /opt/vpn-agent/agent.key
```
> `<CN>` = `vpn-agent-<SERVER_ID>`, e.g. `vpn-agent-gb-lon-01`. The SAN **must**
> include `IP:<NODE_IP>` (the control plane connects by IP) and `IP:127.0.0.1`
> (for the on-box smoke test).

**Pull the PUBLIC cert into the repo** (you'll commit it in Half B):
```bash
# ON YOUR MAC, from the repo root
scp -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP>:/opt/vpn-agent/agent.crt certs/<SERVER_ID>-agent.crt
openssl x509 -in certs/<SERVER_ID>-agent.crt -noout -subject -ext subjectAltName   # sanity check
```
> Only `agent.crt` (public) goes in the repo. `agent.key` (private) stays on the
> droplet, `0600`, never copied anywhere.

---

## A6. systemd unit — run the agent as a service  *(ON THE DROPLET)*

This is the **only** step where you paste the shared `NODE_AGENT_SECRET`. To keep
it out of your shell history/screen, write the file with a placeholder, then edit
it in place.

**Write the unit:**
```bash
# ON THE DROPLET
cat > /etc/systemd/system/vpn-agent.service <<'EOF'
[Unit]
Description=VPN Master Node Agent
After=network.target wg-quick@wg0.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vpn-agent
Environment=AGENT_SECRET=PASTE_SECRET_HERE
Environment=TLS_CERT_FILE=/opt/vpn-agent/agent.crt
Environment=TLS_KEY_FILE=/opt/vpn-agent/agent.key
Environment=AGENT_TLS_PORT=8443
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
```

**Insert the real secret** (get it from Render → Environment → `NODE_AGENT_SECRET`):
```bash
# ON THE DROPLET
nano /etc/systemd/system/vpn-agent.service
```
In nano: press `Ctrl+\` (Replace) → search `PASTE_SECRET_HERE` → replace with the
real secret (paste with `Cmd+V`) → `A` for all → `Ctrl+O`, `Enter` to save →
`Ctrl+X` to exit.

> ⚠️ **Do NOT quote the secret.** systemd treats quotes as literal characters, so
> `AGENT_SECRET="abc"` makes the secret `"abc"` (with quotes) and auth fails.

**Start it and verify:**
```bash
# ON THE DROPLET
systemctl daemon-reload && systemctl enable --now vpn-agent
systemctl status vpn-agent --no-pager           # expect: active (running), enabled
grep AGENT_SECRET /etc/systemd/system/vpn-agent.service   # confirm it's NOT still PASTE_SECRET_HERE
```
If it's crash-looping: `journalctl -u vpn-agent -n 30 --no-pager` (usually a
missing/empty `AGENT_SECRET`).

---

## A7. Firewall — lock the control port to Render  *(ON THE DROPLET)*

The agent's `:8443` must only be reachable by the control plane. Open it **only**
to Render's outbound IP ranges; keep SSH (22) and WireGuard (51820/udp) open to
the world.

> **Get Render's current outbound ranges** from Render → VPN-Master-BE →
> **Connect → Outbound** (Pro plan). As of this writing they are
> `74.220.48.0/24` and `74.220.56.0/24`. **If they differ, use what Render
> shows** — wrong ranges silently drop the control plane (see §T3).

```bash
# ON THE DROPLET — allows 22 FIRST so enabling ufw can't lock you out
ufw allow 22/tcp
ufw allow 51820/udp
ufw allow from 74.220.48.0/24 to any port 8443 proto tcp
ufw allow from 74.220.56.0/24 to any port 8443 proto tcp
echo y | ufw enable
ufw status verbose
```
Expected `ufw status`: `22/tcp` and `51820/udp` from Anywhere; `8443/tcp` only
from the two Render ranges. ufw rules persist across reboot on their own.

> Note: `Default: deny (routed)` in the status output is fine — the
> `iptables -I FORWARD 1 -i wg0 -j ACCEPT` rule from A3 is what permits tunnel
> forwarding, and it sits above ufw's forward chain.

---

## A8. Smoke-test the agent on the box  *(ON THE DROPLET)*

Confirms TLS + the secret + the in-kernel quota table all work locally, before
the control plane ever calls it. This one-liner reads the secret from systemd so
you don't paste it:

```bash
# ON THE DROPLET
SECRET=$(systemctl show vpn-agent -p Environment --value | tr ' ' '\n' | sed -n 's/^AGENT_SECRET=//p')
curl --cacert /opt/vpn-agent/agent.crt https://127.0.0.1:8443/metrics -H "X-Agent-Secret: $SECRET"
nft list table inet wgquota
```
Expected:
- curl → `{"peers":[]}` (empty is correct — no peers yet).
- `nft list table inet wgquota` → the `wgquota` table exists with an empty
  `forward` chain, `policy accept`.

✅ **Half A is done.** The droplet is a fully-configured WireGuard node with the
agent live on 8443.

---

# HALF B — Register the node in the control plane

## B1. Commit the node's public cert  *(already in the repo from A5)*

`services/provisioner/nodeHttp.js` auto-loads **every** `certs/*.crt` as a
trusted CA, so simply having `certs/<SERVER_ID>-agent.crt` in the repo makes the
node trusted after deploy. No env var, no code change. You committed the file in
A5 (or will in B3 below).

## B2. Write the migration  *(ON YOUR MAC, in the repo)*

Migrations are forward-only SQL in `db/migrations/NNN_description.sql`, applied
once each in filename order on every boot (`db/migrate.js`). Create the next
number.

**If your `<SERVER_ID>` is already a placeholder seed** (`de-fra-01`,
`gb-lon-01`, `sg-sin-01` exist as `mock` rows from `002_seed_servers.sql`), it's
an `UPDATE`:

```sql
-- db/migrations/005_activate_gb_lon_01.sql   (bump the number!)
UPDATE servers
SET endpoint      = '<NODE_IP>:51820',
    public_key    = '<the cat server.pub value from A3>',
    tunnel_subnet = '<SUBNET>',
    provisioner   = 'agent',
    agent_url     = 'https://<NODE_IP>:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = '<SERVER_ID>';
```

**If it's a brand-new region not in the seed**, `INSERT` the full catalog row:

```sql
-- db/migrations/005_add_xx_yyy_01.sql
INSERT INTO servers
  (id, name, country, country_code, city, endpoint, public_key,
   tunnel_subnet, load, is_premium, provisioner, agent_url, enabled)
VALUES
  ('<SERVER_ID>', '<City Name>', '<Country>', '<CC>', '<City>',
   '<NODE_IP>:51820', '<public_key>', '<SUBNET>', 0.30, false,
   'agent', 'https://<NODE_IP>:8443', true)
ON CONFLICT (id) DO UPDATE SET
  endpoint = EXCLUDED.endpoint, public_key = EXCLUDED.public_key,
  tunnel_subnet = EXCLUDED.tunnel_subnet, provisioner = EXCLUDED.provisioner,
  agent_url = EXCLUDED.agent_url, enabled = EXCLUDED.enabled, updated_at = now();
```
> `country_code` is ISO 3166-1 alpha-2 (`DE`, `GB`, `SG`) — it drives the flag
> emoji in the app.

## B3. Commit + deploy  *(ON YOUR MAC)*

Push to `main` → Render redeploys and runs the migration on boot.

```bash
# ON YOUR MAC, from the repo root
git add certs/<SERVER_ID>-agent.crt db/migrations/00N_activate_<server_id>.sql
git commit -m "servers: activate <SERVER_ID> (real WireGuard node, <City>)"
git push
```
Also update the **§2 subnet registry** in this file in the same commit.

Watch Render's deploy logs for:
```
[db] ✓ 00N_activate_<server_id>.sql
==> Your service is live 🎉
```

## B4. Verify end-to-end  *(ON YOUR MAC)*

Replace `PASTE_REAL_KEY` with the `API_KEYS` value from Render.

**1. Catalog shows the real node:**
```bash
curl -sS https://nyx-edge.onrender.com/v1/servers -H 'X-API-Key: PASTE_REAL_KEY' \
  | jq '.[] | select(.id=="<SERVER_ID>")'
```
Expect the real `endpoint` (`<NODE_IP>:51820`) and `publicKey`.

**2. A real session (the true proof — exercises the agent over TLS):**
```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST https://nyx-edge.onrender.com/v1/sessions \
  -H 'X-API-Key: PASTE_REAL_KEY' -H 'Content-Type: application/json' \
  -d '{"serverID":"<SERVER_ID>","publicKey":"'"$(head -c32 /dev/urandom | base64)"'"}'
```
Expect `HTTP 200` with `assignedAddresses` of a `<SUBNET first octets>.x` and a
`quota` block.

**3. The peer actually landed in the kernel:**
```bash
ssh -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP> \
  'wg show wg0 | sed -n "/peer:/,\$p"; nft list table inet wgquota'
```
Expect a `peer:` line with `allowed ips: <your allocated IP>/32`, and a
`wgquota` table with a `q_<ip>` quota armed at ~1 GB.

✅ **The node is production-live.** It now appears as a connectable server in the
iOS app (which pulls `/v1/servers`). The test peer has no handshake, so the
reaper auto-removes it within `PEER_TTL_MINUTES` (30). Nothing to clean up.

---

## Rollback

To pull a node out of rotation instantly (no redeploy needed) — run SQL against
the Render Postgres (`psql "$DATABASE_URL"` or the Render dashboard's DB shell):

```sql
-- take it offline (stays in catalog but /sessions refuses it)
UPDATE servers SET enabled = false WHERE id = '<SERVER_ID>';

-- OR revert it to a harmless mock (won't call the agent)
UPDATE servers SET provisioner = 'mock', agent_url = NULL WHERE id = '<SERVER_ID>';
```
Then destroy the droplet in DigitalOcean if you're decommissioning it.

---

## Troubleshooting — the gotchas we actually hit

### T1. `HTTP 000` from a verification curl
Not an API error — curl got no response at all. Almost always the **wrong URL**:
the host is `https://nyx-edge.onrender.com`, **not** `vpn-master-be.onrender.com`
(that doesn't resolve). Also check the service is "Live" in Render, and run with
`-sS` to see the real error (`Could not resolve host`, `timed out`, etc.).

### T2. Handshake works but no internet through the tunnel
The `iptables -I FORWARD 1 -i wg0 -j ACCEPT` rule is missing or landed **below**
ufw's forward chain. ufw's default forward policy is DROP, so the accept rule
must be at the **top** of the `FORWARD` chain. Verify:
```bash
# ON THE DROPLET
iptables -L FORWARD -n -v --line-numbers | head -3   # rule #1 must be ACCEPT in wg0
```
The `-I FORWARD 1` (insert at position 1) in the A3 config guarantees this. Also
confirm IP forwarding is on (`sysctl net.ipv4.ip_forward` → `= 1`) and the
`MASQUERADE` rule exists (`iptables -t nat -L POSTROUTING -n -v | grep -i masq`).

### T3. Control plane can't reach the agent (`/sessions` → "Could not reach the VPN node")
The ufw rule for `:8443` doesn't match Render's **current** outbound ranges — a
Render plan/region change can shift them, and the firewall then drops the control
plane **silently** (no error, just no SYN-ACK). Diagnose on the droplet while a
`/sessions` fires:
```bash
# ON THE DROPLET
tcpdump -tni eth0 'tcp and dst port 8443 and tcp[tcpflags] & tcp-syn != 0' \
  | awk '{print $3}' | sed 's/\.[0-9]*$//' | sort -u
```
Compare against Render → Connect → Outbound, then re-issue the
`ufw allow from <range> to any port 8443 proto tcp` rules for the new ranges.

### T4. Logs show `poll <SERVER_ID> failed: self-signed certificate`
Usually **transient**, from Render's zero-downtime deploy: the *old* instance
(which loaded its trusted certs before your new cert existed) briefly polls the
new node and fails the TLS check, while the *new* instance trusts it fine. It
stops once the old instance is retired. **If it keeps recurring** after the
deploy fully finishes:
- Confirm `certs/<SERVER_ID>-agent.crt` is actually committed and deployed.
- Confirm the committed cert matches the droplet's live cert:
  ```bash
  # ON YOUR MAC
  openssl x509 -in certs/<SERVER_ID>-agent.crt -noout -fingerprint -sha256
  # ON THE DROPLET
  openssl x509 -in /opt/vpn-agent/agent.crt -noout -fingerprint -sha256
  ```
  The two SHA-256 fingerprints must be identical. If not, re-pull the cert (A5)
  and re-commit.

### T5. Agent won't start / auth fails
`journalctl -u vpn-agent -n 30 --no-pager` on the droplet. Most common cause:
`AGENT_SECRET` still says `PASTE_SECRET_HERE`, is quoted, or doesn't match
Render's `NODE_AGENT_SECRET`. Fix the unit (A6), `systemctl daemon-reload &&
systemctl restart vpn-agent`.

---

## Quick reference — one-node cheat sheet

```
Unique per node:  IP, WireGuard keypair, tunnel subnet (10.x.0.0/16), cert file
Shared/identical: NODE_AGENT_SECRET, API_KEYS, the agent code
Ports:            22/tcp (SSH, world) · 51820/udp (WG, world) · 8443/tcp (agent, Render only)
Control-plane URL: https://nyx-edge.onrender.com
Droplet paths:    /etc/wireguard/wg0.conf · /opt/vpn-agent/{index.js,agent.crt,agent.key}
                  /etc/systemd/system/vpn-agent.service
Repo touches:     certs/<SERVER_ID>-agent.crt · db/migrations/NNN_activate_<id>.sql
```
