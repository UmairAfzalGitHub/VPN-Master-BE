# Runbook — Adding (or converting) an IKEv2 VPN node

Step by step, copy-paste-able. Written from the real bring-up of **`gb-lon-01`
(London, `lon.outposttechnologies.co`)** — every command here was run on a real
droplet and verified with a real macOS IKEv2 client.

> **Who this is for:** you, months from now, adding Frankfurt/Singapore/New York
> (or a new city) and having forgotten the details. Follow it top to bottom and
> don't skip the verification blocks — each one catches a mistake we actually made.

---

## 0. The mental model

```
📱 phone ──HTTPS + device token──▶ ☁️ Control plane (Render, nyx-edge.onrender.com)
   │                                        │  HTTPS + X-Agent-Secret (pinned self-signed cert)
   │                                        ▼
   │                               🖥️ Node agent  :8443
   │                                        │ writes EAP user / reads accounting
   │   IKEv2/IPsec (UDP 500/4500)           ▼
   └─────────────────────────────▶ strongSwan ◀──RADIUS──▶ FreeRADIUS ──▶ Postgres (radcheck, radacct)
         THE ACTUAL VPN — never touches Render          ▲
                                                  disconnect (DAE, 127.0.0.1:3799)
```

- **Control plane** (this repo, on Render) owns the server catalog, mints a
  short-lived EAP credential per connect, and drives each node's agent over TLS.
- **The node** (a DigitalOcean droplet) runs **strongSwan** (the tunnel),
  **FreeRADIUS** (checks the credential, records accounting), **Postgres** (FreeRADIUS's
  store) and the **node agent** (`node-agent/index.js`).
- **The phone** uses the OS's native IKEv2 client and validates the server's
  **publicly trusted Let's Encrypt certificate** — so every node needs a **DNS
  hostname**, not just an IP.

**Adding a server = stand up the node (Half A), then register it in Postgres with
a migration (Half B).**

### What must be unique per node vs shared

| Thing | Per node? | Example (London) |
|---|---|---|
| Server `id` | unique | `gb-lon-01` |
| Droplet IP | unique | `144.126.234.98` |
| **DNS hostname** (= `endpoint` = cert SAN = `ike_remote_id`) | unique | `lon.outposttechnologies.co` |
| Virtual-IP pool (`tunnel_subnet`) | unique, never reuse | `10.20.0.0/16` |
| Let's Encrypt cert | unique (per hostname) | issued on the node |
| Agent TLS cert (`certs/<id>-agent.crt`, SAN = node IP) | unique | committed in this repo |
| `NODE_AGENT_SECRET` / agent `AGENT_SECRET` | **shared** | same on every node + Render |
| App `X-API-Key` | shared | unchanged |

### Registry — claim the next free ones (update this table in the same commit)

| Server id | Hostname | Pool | Status |
|---|---|---|---|
| `gb-lon-01` | `lon.outposttechnologies.co` | `10.20.0.0/16` | **live (IKEv2)** |
| `de-fra-01` | `fra.outposttechnologies.co` | `10.21.0.0/16` | to convert |
| `sg-sin-01` | `sin.outposttechnologies.co` | `10.22.0.0/16` | to convert |
| `us-nyc-01` | `nyc.outposttechnologies.co` | `10.23.0.0/16` | to convert |
| — | — | `10.24.0.0/16`… | free |

---

## 1. Before you start

| You need | Where it comes from | Used for |
|---|---|---|
| SSH key | `~/.ssh/digitalocean_vpn_master` on your Mac | every `ssh`/`scp` |
| Droplet, **1 GB RAM**, Ubuntu 24.04 | DigitalOcean (see §1.1) | the node |
| DNS `A` record | Cloudflare → DNS (see §1.2) | hostname → droplet IP |
| `NODE_AGENT_SECRET` | Render → `nyx-edge` → Environment | agent `AGENT_SECRET` (same value everywhere) |
| Render outbound IP ranges | Render → `nyx-edge` → Connect → Outbound | the ufw rule for `:8443` (today `74.220.48.0/24`, `74.220.56.0/24`) |
| An email for Let's Encrypt (optional) | you decide | expiry warnings only |

Set these once in your shell on the node (replace the values):

```bash
export SERVER_ID=gb-lon-01
export HOST=lon.outposttechnologies.co
export POOL=10.20.0.0/16
export NODE_IP=144.126.234.98
```

### 1.1 The droplet — why 1 GB

strongSwan + FreeRADIUS + Postgres + the agent do **not** fit comfortably in the
old 512 MB droplets (~230 MB free). Use **Basic → Regular → 1 GB / 1 vCPU ($6)**.

- **Converting an existing droplet:** power it off → Droplet → **Resize** → tick
  **"Downscale anytime by keeping the storage size fixed"** (= *CPU and RAM only*,
  reversible) → pick the 1 GB plan → **Resize Droplet** → power on. The IP is kept.
- Small plans sell out per region ("unavailable in your selected region"). Try the
  *Premium Intel* 1 GB plan (~$8) or resize a droplet in another region.
- Confirm after boot: `free -m` shows ~960 MB total.

### 1.2 DNS (Cloudflare)

Cloudflare → the domain → **DNS → Records → Add record**: type `A`, name
`lon` (→ `lon.outposttechnologies.co`), IPv4 = the droplet IP, TTL Auto,
**Proxy status: DNS only (grey cloud)**. The orange proxy breaks VPN traffic and
certificate issuance. Don't touch the existing MX/TXT records (Hostinger email).

```bash
dig +short A $HOST            # on your Mac; must print the droplet IP
dig +short A $HOST @1.1.1.1   # use this if your own resolver cached an old "not found"
```

---

# HALF A — The node

All of Half A runs **on the droplet** (`ssh -i ~/.ssh/digitalocean_vpn_master root@$NODE_IP`)
unless a step says *(Mac)*.

## A1. Base system, swap, firewall, forwarding

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade

# 1 GB swap — a safety net, not a plan
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/98-swappiness.conf

# route tunnel traffic to the internet
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-ip-forward.conf
sysctl --system >/dev/null

# firewall — allow SSH FIRST so enabling ufw can't lock you out
ufw allow 22/tcp
ufw allow 80/tcp                 # Let's Encrypt (and its renewals)
ufw allow 500/udp                # IKE
ufw allow 4500/udp               # IKE NAT-T / ESP-in-UDP
ufw allow from 74.220.48.0/24 to any port 8443 proto tcp   # Render only — agent
ufw allow from 74.220.56.0/24 to any port 8443 proto tcp
echo y | ufw enable
ufw status verbose
```

> **Render ranges:** use whatever Render → Connect → Outbound shows *now*. Wrong
> ranges make the control plane's calls vanish silently (see §Troubleshooting T3).

## A2. Install the software

```bash
apt-get install -y certbot strongswan-swanctl charon-systemd libcharon-extra-plugins \
  libstrongswan-extra-plugins freeradius freeradius-postgresql freeradius-utils \
  postgresql nodejs npm
systemctl stop freeradius        # it starts on a stock config + default secret; stop it until A6
```

`freeradius-utils` provides `radclient`, which the agent uses to disconnect live
sessions — **without it disconnects silently do nothing**. Node ≥ 18 is required
(Ubuntu 24.04's apt `nodejs` is 18.19 — fine).

## A3. Let's Encrypt certificate (+ renewal hook)

By running this you accept the Let's Encrypt Subscriber Agreement
(<https://letsencrypt.org/repository/>). Use `--register-unsafely-without-email`
instead of `-m` if you don't want expiry warnings.

```bash
certbot certonly --standalone --non-interactive --agree-tos --no-eff-email \
  -m info@outposttechnologies.co -d $HOST
```

Let's Encrypt's current chain is **leaf → YE1 → Root YE → ISRG Root X2 → ISRG
Root X1**, i.e. **three intermediates** between the leaf and the root phones trust
(X1). strongSwan only loads the first cert of a multi-cert file, so a phone would
receive an incomplete chain and **reject the server**. The hook below splits the
chain into one file per cert, and it re-runs on every renewal:

```bash
mkdir -p /etc/swanctl/x509 /etc/swanctl/x509ca /etc/swanctl/private
cat > /etc/letsencrypt/renewal-hooks/deploy/strongswan.sh <<EOF
#!/bin/sh
# After every renewal: install leaf + EVERY intermediate + key, reload strongSwan.
set -e
D="\${RENEWED_LINEAGE:-/etc/letsencrypt/live/$HOST}"
install -m 644 "\$D/cert.pem"    /etc/swanctl/x509/server.pem
install -m 600 "\$D/privkey.pem" /etc/swanctl/private/server.key
rm -f /etc/swanctl/x509ca/le-chain-*.pem
csplit -s -z -f /etc/swanctl/x509ca/le-chain- -b '%02d.pem' "\$D/chain.pem" '/-----BEGIN CERTIFICATE-----/' '{*}'
chmod 644 /etc/swanctl/x509ca/le-chain-*.pem
swanctl --load-creds >/dev/null 2>&1 || true
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/strongswan.sh
/etc/letsencrypt/renewal-hooks/deploy/strongswan.sh      # run once now
ls /etc/swanctl/x509ca/                                   # expect le-chain-00.pem .. le-chain-02.pem
certbot renew --dry-run 2>&1 | grep -E "Congratulations|failed"
```

**Verify the chain the way an older phone sees it** (trusts only Root X1):

```bash
L=/etc/letsencrypt/live/$HOST
openssl verify -no-CApath -CAfile /usr/share/ca-certificates/mozilla/ISRG_Root_X1.crt \
  -untrusted $L/chain.pem -verify_hostname $HOST $L/cert.pem      # must print: OK
```

## A4. Shared secrets (root-only file)

Generated on the node and never printed or committed. The `( … )` subshell keeps
`umask 077` from leaking into later steps (that exact leak once made Postgres
unable to read its own config).

```bash
mkdir -p /etc/ikev2-node && chmod 700 /etc/ikev2-node
( umask 077
  printf 'RADIUS_SECRET=%s\nDAE_SECRET=%s\nPG_RADIUS_PASS=%s\nPG_AGENT_PASS=%s\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 20)" "$(openssl rand -hex 20)" \
    > /etc/ikev2-node/secrets.env )
chmod 600 /etc/ikev2-node/secrets.env
. /etc/ikev2-node/secrets.env
```

(Every later step starts with `. /etc/ikev2-node/secrets.env`.)

## A5. strongSwan

**RADIUS client, accounting and the disconnect listener** — this is where the
usage numbers and the quota cutoff come from:

```bash
. /etc/ikev2-node/secrets.env
cat > /etc/strongswan.d/zz-vpn.conf <<EOF
charon {
  plugins {
    eap-radius {
      accounting = yes
      accounting_interval = 15      # interim byte counts every 15 s (see "quota overshoot" below)
      nas_identifier = $HOST
      servers {
        primary {
          address = 127.0.0.1
          secret = $RADIUS_SECRET
          auth_port = 1812
          acct_port = 1813
        }
      }
      dae {                          # RADIUS Disconnect — the agent kicks live sessions here
        enable = yes
        listen = 127.0.0.1
        port = 3799
        secret = $DAE_SECRET
      }
    }
  }
}
EOF
chmod 600 /etc/strongswan.d/zz-vpn.conf
```

> The disconnect listener lives **in strongSwan** (`dae { … }` above), *not* in
> FreeRADIUS. (An earlier draft of the agent README said otherwise — it was wrong.)

> **Pinned cryptography — keep these in step with the apps.** Every suite in `proposals` /
> `esp_proposals` below is **AES-256** (GCM, or CBC with SHA-256): no 128-bit AES, no SHA-1, no
> MODP-1024, so the app's "Encryption: AES-256" is true for *any* client. Preference order is
> AES-256-GCM with Curve25519 → P-384 → P-256 → MODP-2048, then AES-256-CBC + SHA-256 as a fallback
> for clients that won't do GCM. The iOS app pins **AES-256-GCM + SHA-384 PRF + Curve25519 (DH 31)**
> in `TunnelManager.install`; Android restricts the profile to `STRONG_ALGORITHMS` (AES-GCM, or
> AES-CBC + SHA-2). Change a list here and you must change the apps (and vice versa), or clients
> stop negotiating. Check what a client actually got with `swanctl --list-sas`
> (e.g. `AES_GCM_16-256/PRF_HMAC_SHA2_384/CURVE_25519` and `ESP:AES_GCM_16-256`).

**The connection:**

```bash
cat > /etc/swanctl/conf.d/vpn.conf <<EOF
connections {
  ikev2-eap {
    version = 2
    local_addrs = %any
    pools = vip_pool
    send_certreq = no
    send_cert = always             # clients don't all ask for the cert; send it unprompted
    fragmentation = yes
    mobike = yes
    dpd_delay = 30s
    reauth_time = 0s               # never re-run EAP mid-session (see the expiry note in §A8)
    proposals = aes256gcm16-prfsha384-curve25519,aes256gcm16-prfsha256-curve25519,aes256gcm16-prfsha384-ecp384,aes256gcm16-prfsha256-ecp256,aes256gcm16-prfsha256-modp2048,aes256-sha256-curve25519,aes256-sha256-ecp256,aes256-sha256-modp2048
    local {
      auth = pubkey
      certs = server.pem
      id = $HOST                   # must equal the cert SAN and servers.ike_remote_id
    }
    remote {
      auth = eap-radius
      eap_id = %any
    }
    children {
      net {
        local_ts = 0.0.0.0/0
        esp_proposals = aes256gcm16,aes256-sha256
        dpd_action = clear
      }
    }
  }
}
pools {
  vip_pool {
    addrs = $POOL
    dns = 1.1.1.1, 1.0.0.1
  }
}
EOF
systemctl restart strongswan; sleep 3
swanctl --load-all
swanctl --list-conns | head -3
swanctl --list-certs | grep -E "subject:"          # leaf + 3 chain certs
ss -H -lun | awk '{print $4}' | grep -E ':(500|4500|3799)$' | sort -u   # 500, 4500 and 127.0.0.1:3799
```

## A6. Postgres + FreeRADIUS

### Postgres (small-memory, localhost only)

```bash
. /etc/ikev2-node/secrets.env
cat > /etc/postgresql/16/main/conf.d/vpn-lowmem.conf <<'EOF'
listen_addresses = '127.0.0.1'
shared_buffers = 24MB
max_connections = 30
work_mem = 2MB
maintenance_work_mem = 16MB
effective_cache_size = 128MB
wal_buffers = 1MB
max_wal_size = 256MB
EOF
chmod 644 /etc/postgresql/16/main/conf.d/vpn-lowmem.conf     # postgres must be able to read it
systemctl restart postgresql@16-main; sleep 3; pg_lsclusters | tail -1      # must say "online"

# two logins: FreeRADIUS owns the DB; the AGENT only gets what it needs
sudo -u postgres psql -q <<SQL
CREATE ROLE radius   LOGIN PASSWORD '$PG_RADIUS_PASS';
CREATE ROLE vpnagent LOGIN PASSWORD '$PG_AGENT_PASS';
SQL
sudo -u postgres createdb -O radius radius
PGPASSWORD=$PG_RADIUS_PASS psql -h 127.0.0.1 -U radius -d radius -q -v ON_ERROR_STOP=1 \
  -f /etc/freeradius/3.0/mods-config/sql/main/postgresql/schema.sql
PGPASSWORD=$PG_RADIUS_PASS psql -h 127.0.0.1 -U radius -d radius -q <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON radcheck TO vpnagent;
GRANT USAGE, SELECT ON SEQUENCE radcheck_id_seq TO vpnagent;
GRANT SELECT ON radacct TO vpnagent;
SQL
```

> **No unique index is needed on `radcheck`.** The agent replaces the user row in a
> transaction. (The stock schema only has a non-unique index there; an earlier
> `ON CONFLICT` version of the agent failed with *"no unique or exclusion
> constraint matching the ON CONFLICT specification"*.)

### FreeRADIUS

```bash
. /etc/ikev2-node/secrets.env
cd /etc/freeradius/3.0
for f in mods-available/sql clients.conf sites-available/default mods-available/eap radiusd.conf; do cp -n $f $f.orig; done

# SQL module -> Postgres, small pool
cat > mods-available/sql <<EOF
sql {
	driver = "rlm_sql_postgresql"
	dialect = "postgresql"
	server = "127.0.0.1"
	port = 5432
	login = "radius"
	password = "$PG_RADIUS_PASS"
	radius_db = "radius"
	acct_table1 = "radacct"
	acct_table2 = "radacct"
	postauth_table = "radpostauth"
	authcheck_table = "radcheck"
	groupcheck_table = "radgroupcheck"
	authreply_table = "radreply"
	groupreply_table = "radgroupreply"
	usergroup_table = "radusergroup"
	read_groups = no
	read_profiles = no
	delete_stale_sessions = yes
	sql_user_name = "%{User-Name}"
	pool { start = 2  min = 1  max = 6  spare = 1  uses = 0  retry_delay = 30  lifetime = 0  idle_timeout = 60 }
	read_clients = no
	client_table = "nas"
	group_attribute = "SQL-Group"
	\$INCLUDE \${modconfdir}/\${.:name}/main/\${dialect}/queries.conf
}
EOF
chown freerad:freerad mods-available/sql; chmod 640 mods-available/sql
ln -sf ../mods-available/sql mods-enabled/sql

sed -i "s/secret\s*=\s*testing123/secret = $RADIUS_SECRET/" clients.conf        # replace the stock secret
sed -i 's/ipaddr = \*/ipaddr = 127.0.0.1/; s/^\(\s*ipv6addr = \)::\(\s*\(#.*\)\?\)$/\1::1\2/' sites-available/default   # loopback only
sed -i 's/default_eap_type = md5/default_eap_type = mschapv2/' mods-available/eap                               # phones use EAP-MSCHAPv2
sed -i 's/^\(\s*start_servers = \)[0-9]*/\12/; s/^\(\s*max_servers = \)[0-9]*/\18/; s/^\(\s*min_spare_servers = \)[0-9]*/\11/; s/^\(\s*max_spare_servers = \)[0-9]*/\13/' radiusd.conf

freeradius -CX 2>&1 | tail -1          # "Configuration appears to be OK"
systemctl enable --now freeradius; sleep 3
ss -H -lun | awk '{print $4}' | grep -E ':(1812|1813)$'       # 127.0.0.1 and [::1] only
```

**Verify FreeRADIUS** (these are the tests that matter — all must match):

```bash
. /etc/ikev2-node/secrets.env
A="env PGPASSWORD=$PG_AGENT_PASS psql -h 127.0.0.1 -U vpnagent -d radius -tAq"
$A -c "insert into radcheck(username,attribute,op,value) values ('zz_test','Cleartext-Password',':=','TestPass_1')"
radtest -t mschap zz_test TestPass_1 127.0.0.1 0 "$RADIUS_SECRET" | grep -oE 'Access-(Accept|Reject)'   # Accept
radtest -t mschap zz_test WrongPass 127.0.0.1 0 "$RADIUS_SECRET" 2>&1 | grep -oE 'Access-Reject'         # Reject
printf 'Acct-Status-Type=Start,Acct-Session-Id=t1,User-Name=zz_test,Framed-IP-Address=10.20.0.9,NAS-IP-Address=127.0.0.1,NAS-Port-Type=Virtual\n' | radclient 127.0.0.1:1813 acct "$RADIUS_SECRET"
printf 'Acct-Status-Type=Interim-Update,Acct-Session-Id=t1,User-Name=zz_test,Framed-IP-Address=10.20.0.9,NAS-IP-Address=127.0.0.1,NAS-Port-Type=Virtual,Acct-Input-Octets=123456,Acct-Output-Octets=654321,Acct-Session-Time=60\n' | radclient 127.0.0.1:1813 acct "$RADIUS_SECRET"
$A -c "select acctinputoctets,acctoutputoctets,host(framedipaddress) from radacct where username='zz_test'"   # 123456|654321|10.20.0.9
# clean up the test rows
$A -c "delete from radcheck where username='zz_test'"
env PGPASSWORD=$PG_RADIUS_PASS psql -h 127.0.0.1 -U radius -d radius -q -c "delete from radacct where username='zz_test'; delete from radpostauth where username='zz_test'"
```

## A7. The node agent

The agent is `node-agent/index.js` in this repo. It runs as a **non-root** user.

**(Mac)** copy it over:

```bash
ssh -i ~/.ssh/digitalocean_vpn_master root@$NODE_IP 'useradd --system --home /opt/vpn-agent-ikev2 --shell /usr/sbin/nologin vpnagent; mkdir -p /opt/vpn-agent-ikev2; chown vpnagent:vpnagent /opt/vpn-agent-ikev2'
scp -i ~/.ssh/digitalocean_vpn_master node-agent/index.js root@$NODE_IP:/opt/vpn-agent-ikev2/index.js
ssh -i ~/.ssh/digitalocean_vpn_master root@$NODE_IP 'cd /opt/vpn-agent-ikev2 && npm i express pg --no-fund --no-audit && chown -R vpnagent:vpnagent .'
```

**Agent TLS certificate** (self-signed, SAN = the node's IP; the control plane pins it
from `certs/`). Pick one:

- **New droplet** — generate it and bring the public half home *(Mac second command)*:
  ```bash
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /opt/vpn-agent-ikev2/agent.key -out /opt/vpn-agent-ikev2/agent.crt -days 3650 \
    -subj "/CN=vpn-agent-$SERVER_ID" -addext "subjectAltName=IP:$NODE_IP,IP:127.0.0.1"
  chown vpnagent:vpnagent /opt/vpn-agent-ikev2/agent.*; chmod 600 /opt/vpn-agent-ikev2/agent.key
  # (Mac)
  scp -i ~/.ssh/digitalocean_vpn_master root@$NODE_IP:/opt/vpn-agent-ikev2/agent.crt certs/$SERVER_ID-agent.crt
  ```
- **Converting a droplet that already has one** (`/opt/vpn-agent/agent.{crt,key}` from the WireGuard
  days; the same cert is already committed as `certs/<id>-agent.crt`) — just copy it:
  ```bash
  install -m 644 -o vpnagent -g vpnagent /opt/vpn-agent/agent.crt /opt/vpn-agent-ikev2/agent.crt
  install -m 600 -o vpnagent -g vpnagent /opt/vpn-agent/agent.key /opt/vpn-agent-ikev2/agent.key
  ```
  Confirm the repo copy matches: `openssl x509 -in certs/<id>-agent.crt -noout -fingerprint -sha256`
  on your Mac must equal the same command on the node.

**Config + service.** `AGENT_SECRET` must equal Render's `NODE_AGENT_SECRET`. Paste it
into `agent.env` yourself (or, when converting, read it from the old unit):

```bash
. /etc/ikev2-node/secrets.env
( umask 077
cat > /etc/ikev2-node/agent.env <<EOF
AGENT_SECRET=PASTE_NODE_AGENT_SECRET_HERE
RADIUS_DATABASE_URL=postgres://vpnagent:$PG_AGENT_PASS@127.0.0.1:5432/radius
DAE_SERVER=127.0.0.1:3799
DAE_SECRET=$DAE_SECRET
TLS_CERT_FILE=/opt/vpn-agent-ikev2/agent.crt
TLS_KEY_FILE=/opt/vpn-agent-ikev2/agent.key
AGENT_TLS_PORT=8443
AGENT_PORT=8080
AGENT_STATE_FILE=/var/lib/vpn-agent-ikev2/creds.json
IKEV2_SWEEP_INTERVAL_MS=5000
EOF
)
nano /etc/ikev2-node/agent.env      # replace PASTE_NODE_AGENT_SECRET_HERE — no quotes

cat > /etc/systemd/system/vpn-agent-ikev2.service <<'EOF'
[Unit]
Description=VPN IKEv2 Node Agent (strongSwan + FreeRADIUS)
After=network.target postgresql.service freeradius.service strongswan.service

[Service]
Type=simple
User=vpnagent
WorkingDirectory=/opt/vpn-agent-ikev2
EnvironmentFile=/etc/ikev2-node/agent.env
StateDirectory=vpn-agent-ikev2
ExecStart=/usr/bin/node index.js
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now vpn-agent-ikev2; sleep 3
systemctl is-active vpn-agent-ikev2        # active  (HTTPS :8443, plain HTTP on 127.0.0.1:8080 only)
```

> Don't quote the secret: systemd/`EnvironmentFile` would keep the quotes as part
> of the value and auth fails silently.

**Verify the agent** (as the control plane would, over TLS, with the pinned cert):

```bash
SEC=$(grep ^AGENT_SECRET= /etc/ikev2-node/agent.env | cut -d= -f2-)
C="curl -s --cacert /opt/vpn-agent-ikev2/agent.crt -H X-Agent-Secret:$SEC -H Content-Type:application/json -w [HTTP%{http_code}]\n"
$C -X POST https://127.0.0.1:8443/credentials -d '{"username":"u_agenttest","password":"First_pw-1","remainingBytes":1073741824,"expiresAt":"2030-01-01T00:00:00Z"}'   # {"success":true}[HTTP200]
$C -X POST https://127.0.0.1:8443/credentials -d '{"username":"u_agenttest","password":"Second_pw-2","remainingBytes":1073741824,"expiresAt":"2030-01-01T00:00:00Z"}'  # upsert: still ONE row
$C https://127.0.0.1:8443/accounting                          # {"sessions":[...]}
$C -X DELETE https://127.0.0.1:8443/credentials -d '{"username":"u_agenttest"}'
printf 'User-Name = "nobody"\n' | radclient -x 127.0.0.1:3799 disconnect "$DAE_SECRET" 2>&1 | grep -E "Disconnect-(ACK|NAK)"   # NAK = reachable + secret OK
```

## A8. NAT, MSS clamp and forwarding (ufw)

IKEv2 clients get addresses from `$POOL`; their traffic must be NAT'd out of the
droplet. Done in ufw's `before.rules` (with automatic rollback if ufw rejects it):

```bash
cp -n /etc/ufw/before.rules /etc/ufw/before.rules.pre-ikev2
if ! grep -q "BEGIN ikev2-nat" /etc/ufw/before.rules; then
  { cat <<EOF
# BEGIN ikev2-nat
*nat
:POSTROUTING ACCEPT [0:0]
-A POSTROUTING -s $POOL -o eth0 -j MASQUERADE
COMMIT
*mangle
:FORWARD ACCEPT [0:0]
-A FORWARD -s $POOL -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
-A FORWARD -d $POOL -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
COMMIT
# END ikev2-nat
EOF
  cat /etc/ufw/before.rules.pre-ikev2; } > /etc/ufw/before.rules
fi
ufw route allow from $POOL
ufw reload | grep -i reloaded || { cp /etc/ufw/before.rules.pre-ikev2 /etc/ufw/before.rules; ufw reload; echo "ROLLED BACK"; }
iptables -t nat -S POSTROUTING | grep $POOL                 # MASQUERADE rule present
```

> `eth0` is the public interface on DigitalOcean (`ip route | grep default`). Change
> it above if yours differs.

### A9. Final health check

```bash
for s in strongswan freeradius postgresql@16-main vpn-agent-ikev2 certbot.timer ufw; do printf "%-20s %s\n" $s "$(systemctl is-active $s)"; done
free -m | awk 'NR<=3'                                           # a few hundred MB "available"
certbot certificates | grep -E "Domains|Expiry"                 # ~89 days
ufw status | grep -E "^(22|80|500|4500|8443)"
```

✅ **Half A is done.** (Converting a droplet that ran WireGuard? Do §C now.)

---

# HALF B — Register the node in the control plane *(Mac, this repo)*

## B1. The agent certificate

New droplet: `certs/<SERVER_ID>-agent.crt` was copied in §A7 — commit it
(`services/provisioner/nodeHttp.js` trusts every `certs/*.crt`; no env var, no
code change). Converted droplet: it's already committed.

## B2. The migration

Forward-only SQL in `db/migrations/NNN_description.sql` (next number: `015_…`).
For a server row that already exists (every seeded city does):

```sql
-- db/migrations/015_activate_de_fra_01_ikev2.sql
UPDATE servers
SET provisioner   = 'ikev2',
    endpoint      = 'fra.outposttechnologies.co',   -- HOSTNAME only, no :port
    ike_remote_id = 'fra.outposttechnologies.co',   -- = the Let's Encrypt cert SAN
    ca_cert       = NULL,                           -- phones use system trust
    tunnel_subnet = '10.21.0.0/16',                 -- the strongSwan pool
    agent_url     = 'https://<NODE_IP>:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = 'de-fra-01';
```

For a brand-new city not in the seed:

```sql
INSERT INTO servers (id, name, country, country_code, city, endpoint, ike_remote_id,
                     tunnel_subnet, load, is_premium, provisioner, agent_url, enabled)
VALUES ('xx-yyy-01', '<City>', '<Country>', '<CC>', '<City>', '<host>', '<host>',
        '10.2N.0.0/16', 0.30, false, 'ikev2', 'https://<NODE_IP>:8443', true)
ON CONFLICT (id) DO UPDATE SET
  endpoint = EXCLUDED.endpoint, ike_remote_id = EXCLUDED.ike_remote_id,
  tunnel_subnet = EXCLUDED.tunnel_subnet, provisioner = EXCLUDED.provisioner,
  agent_url = EXCLUDED.agent_url, enabled = EXCLUDED.enabled, updated_at = now();
```

`country_code` is ISO 3166-1 alpha-2 (drives the flag emoji). The row only becomes
`available: true` (shown as connectable) when `provisioner = 'ikev2'` **and** `agent_url`
is set and `enabled`.

## B3. Deploy

```bash
git add certs/$SERVER_ID-agent.crt db/migrations/015_*.sql docs/RUNBOOK-add-server.md
git commit -m "servers: activate $SERVER_ID (IKEv2)"
git push
```

Render redeploys and runs the migration at boot. In the deploy log look for
`[db] ✓ 015_….sql`. If the deploy fails with `ECONNREFUSED …:5432` the database was
briefly down — the backend now retries for ~60 s, so just redeploy (Manual Deploy →
Deploy latest commit). Update the registry table at the top of this file too.

## B4. Verify the control plane reaches the node

The node's agent only gets a visit from Render if the row is live and the firewall
rule is right. Count reads of `radacct` over a minute (the poller runs every 60 s):

```bash
# on the node
. /etc/ikev2-node/secrets.env
Q() { env PGPASSWORD=$PG_RADIUS_PASS psql -h 127.0.0.1 -U radius -d radius -tAc "$1"; }
S1=$(Q "select coalesce(seq_scan,0)+coalesce(idx_scan,0) from pg_stat_user_tables where relname='radacct'")
sleep 70
S2=$(Q "select coalesce(seq_scan,0)+coalesce(idx_scan,0) from pg_stat_user_tables where relname='radacct'")
echo "polls in 70s: $((S2-S1))"        # >= 1 means Render reaches the agent over TLS with the right secret
```

And from your Mac, with the app key:

```bash
curl -s https://nyx-edge.onrender.com/v1/servers -H 'X-API-Key: <API_KEY>' | grep -o '"id":"gb-lon-01"[^}]*'
# expect endpoint = the hostname, "available":true
```

---

# C. Converting a node that ran WireGuard

Do Half A first (they coexist until the agent port is needed). When the IKEv2 agent
is verified, remove WireGuard. **Look at what you're deleting first.**

```bash
ls -la /etc/wireguard /opt/vpn-agent                       # server keys, wg0.conf, the old agent
systemctl disable --now vpn-agent wg-quick@wg0             # frees :8443 for the new agent
ufw delete allow 51820/udp
apt-get purge -y wireguard wireguard-tools
rm -f /etc/systemd/system/vpn-agent.service
rm -rf /etc/wireguard /opt/vpn-agent                       # the new agent has its own copies of the cert/key
mv /etc/sysctl.d/99-wg.conf /etc/sysctl.d/99-ip-forward.conf   # KEEP forwarding, just rename it
systemctl daemon-reload && sysctl --system >/dev/null
sysctl -n net.ipv4.ip_forward                              # must still be 1
```

> Start the IKEv2 agent only *after* stopping the old one: both want `:8443`.

---

# D. Test with a real client (before involving the apps)

Create a **short-lived test login through the real agent** (it auto-expires and the
agent disconnects it), then install a profile on a Mac or iPhone.

```bash
# (Mac) make a password and register it on the node; expires in 60 minutes, 200 MB cap
PASS=$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '=\n')
EXP=$(date -u -v+60M +%Y-%m-%dT%H:%M:%SZ)
printf '%s' "$PASS" | ssh -i ~/.ssh/digitalocean_vpn_master root@$NODE_IP \
 'P=$(cat); SEC=$(grep ^AGENT_SECRET= /etc/ikev2-node/agent.env | cut -d= -f2-); curl -s --cacert /opt/vpn-agent-ikev2/agent.crt -X POST https://127.0.0.1:8443/credentials -H "X-Agent-Secret: $SEC" -H "Content-Type: application/json" -d "{\"username\":\"u_clitest01\",\"password\":\"$P\",\"remainingBytes\":209715200,\"expiresAt\":\"'"$EXP"'\"}"'
```

`.mobileconfig` (replace `HOST`, `PASSWORD`, and use two fresh UUIDs from `uuidgen`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadDisplayName</key><string>IKEv2 test</string>
  <key>PayloadIdentifier</key><string>co.example.vpntest</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>UUID-1</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadContent</key><array><dict>
    <key>PayloadType</key><string>com.apple.vpn.managed</string>
    <key>PayloadIdentifier</key><string>co.example.vpntest.vpn</string>
    <key>PayloadUUID</key><string>UUID-2</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>UserDefinedName</key><string>IKEv2 test</string>
    <key>VPNType</key><string>IKEv2</string>
    <key>IKEv2</key><dict>
      <key>RemoteAddress</key><string>HOST</string>
      <key>RemoteIdentifier</key><string>HOST</string>
      <key>LocalIdentifier</key><string>u_clitest01</string>
      <key>AuthenticationMethod</key><string>None</string>
      <key>ExtendedAuthEnabled</key><integer>1</integer>
      <key>AuthName</key><string>u_clitest01</string>
      <key>AuthPassword</key><string>PASSWORD</string>
      <key>DeadPeerDetectionRate</key><string>Medium</string>
    </dict>
  </dict></array>
</dict></plist>
```

Install it yourself (macOS: double-click → *System Settings → Device Management/Profiles → Install*;
iPhone: AirDrop → *Settings → Profile Downloaded → Install*), connect from *Settings → VPN*, then
watch the node:

```bash
swanctl --list-sas                      # ESTABLISHED, remote 'u_clitest01', virtual IP from the pool, bytes moving
. /etc/ikev2-node/secrets.env
env PGPASSWORD=$PG_RADIUS_PASS psql -h 127.0.0.1 -U radius -d radius -tA -c \
 "select acctupdatetime, acctinputoctets, acctoutputoctets, host(framedipaddress) from radacct where username='u_clitest01'"
```

On the client: `https://ifconfig.me` should show the **node's IP**. Pass criteria:
authenticates, gets a pool IP, interim accounting rows every ~15 s, and — if you
download past the cap — the agent drops it (`journalctl -u vpn-agent-ikev2` shows
`dropping … quota`, strongSwan logs the Disconnect-Request, `radacct` gets a stop row).

---

# E. Operating the node

| Task | How |
|---|---|
| Update the agent | `scp node-agent/index.js root@<ip>:/opt/vpn-agent-ikev2/index.js && ssh root@<ip> 'chown vpnagent:vpnagent /opt/vpn-agent-ikev2/index.js; systemctl restart vpn-agent-ikev2'` |
| Cert renewal | automatic (`certbot.timer`); hook reloads strongSwan; `certbot renew --dry-run` to test. Needs port 80 open |
| Rotate the disconnect secret | new value in `secrets.env`, `agent.env`, and `zz-vpn.conf` (`dae { secret }`), then `systemctl restart strongswan vpn-agent-ikev2` |
| Live sessions | `swanctl --list-sas` |
| Logs | `journalctl -u strongswan -u vpn-agent-ikev2 -u freeradius -f` |
| Roll a node back out of rotation | `UPDATE servers SET enabled = false WHERE id = '<id>';` (Render DB shell) |
| Resize | Droplet → Resize (CPU and RAM only keeps it reversible) |

**Quota overshoot.** The cap is enforced from accounting that arrives every
`accounting_interval` (15 s) and is checked every `IKEV2_SWEEP_INTERVAL_MS` (5 s). At
very high speed a session can run past its cap by roughly speed × ~20 s. (At the original
60 s interval a speed test overshot a 200 MB cap by ~180 MB.) For an exact byte cap you'd add a
per-virtual-IP `nftables` quota — not built.

**Credential expiry.** A minted credential is valid for `IKEV2_CRED_TTL_SECONDS` (default
24 h). Both the node's sweep and the backend's reaper disconnect a session whose credential
has expired, so a connected session ends at that mark. A *short* TTL (a tighter
"must connect from the app" gate) would cut live sessions; separating "gate for new
connects" from "session lifetime" is an open design item.

**Not built yet / known gaps:** pruning old `radacct` rows (they accumulate; the BE ledger
is authoritative, so prune stopped sessions older than a few days — also good for the "no
logs" promise); IPv6 for clients (only IPv4 is assigned, so a client's IPv6 may bypass the
tunnel); per-IP `nftables` hard cap.

---

# Troubleshooting — the gotchas we actually hit

**T1. Postgres won't start after tuning** — `Permission denied` on `conf.d/vpn-lowmem.conf`.
A leaked `umask 077` made the file root-only. `chmod 644` it. (§A4 uses a subshell for this reason.)

**T2. Phone says the server certificate isn't trusted** — the chain is incomplete. Check
`ls /etc/swanctl/x509ca/` (three `le-chain-*.pem`), `send_cert = always` is in `vpn.conf`, and
the §A3 `openssl verify` against Root X1 only prints `OK`.

**T3. Control plane can't reach the agent** (`/sessions` → "Could not reach the VPN node",
usage never advances). The ufw rule for `:8443` doesn't match Render's *current* outbound
ranges — the firewall drops silently. While a `/sessions` fires:
```bash
tcpdump -tni eth0 'tcp and dst port 8443 and tcp[tcpflags] & tcp-syn != 0' | awk '{print $3}' | sed 's/\.[0-9]*$//' | sort -u
```
Compare with Render → Connect → Outbound and re-issue the `ufw allow from … 8443` rules.

**T4. Every `/v1/sessions` returns 502** — the agent is failing. `journalctl -u vpn-agent-ikev2`.
Typical causes: wrong `AGENT_SECRET` (must equal Render's `NODE_AGENT_SECRET`, unquoted), the
agent can't reach Postgres (`RADIUS_DATABASE_URL`/password), or the agent cert on the node
doesn't match `certs/<id>-agent.crt` (compare SHA-256 fingerprints).

**T5. Sessions drop ~30 minutes after connecting** — the reaper removes sessions with no
accounting for 30 min. strongSwan only sends interim updates if `accounting = yes` and
`accounting_interval` are set in `zz-vpn.conf`.

**T6. Disconnects do nothing** — `radclient` missing (`apt-get install freeradius-utils`) or
`DAE_SECRET` in `agent.env` differs from `dae { secret }` in `zz-vpn.conf`. Test with the
`radclient … disconnect` line in §A7: a `Disconnect-NAK` is the *good* answer.

**T7. Render deploy fails with `connect ECONNREFUSED …:5432`** — the Render Postgres was
briefly unavailable. The backend retries for ~60 s at boot (`DB_CONNECT_RETRIES` /
`DB_CONNECT_DELAY_MS`); if it still fails, wait and redeploy.

**T8. `HTTP 000` from a verification curl** — wrong URL. The control plane is
`https://nyx-edge.onrender.com`. Your resolver may also have cached a stale "not found" for
a brand-new DNS name; query `@1.1.1.1`.

**T9. DigitalOcean: "plan unavailable in your selected region"** — see §1.1.

---

## Cheat sheet

```
Per node:   id, IP, hostname (cert SAN), pool 10.2N.0.0/16, agent cert (SAN = IP)
Shared:     NODE_AGENT_SECRET (Render) = agent AGENT_SECRET, app X-API-Key
Ports:      22/tcp world · 80/tcp world (cert) · 500/udp + 4500/udp world · 8443/tcp Render only
Node files: /etc/swanctl/conf.d/vpn.conf · /etc/strongswan.d/zz-vpn.conf · /etc/freeradius/3.0/
            /etc/ikev2-node/{secrets.env,agent.env} · /opt/vpn-agent-ikev2/ · /etc/ufw/before.rules
Services:   strongswan freeradius postgresql@16-main vpn-agent-ikev2 certbot.timer
Repo:       certs/<id>-agent.crt · db/migrations/NNN_*.sql · node-agent/index.js
Control plane: https://nyx-edge.onrender.com
```
