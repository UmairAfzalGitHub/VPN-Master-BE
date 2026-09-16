# VPN Master — WireGuard Node Agent

Runs on each WireGuard node (Linux). The only component that touches `wg`; the
control plane on Render drives it over HTTP. See `index.js` for the contract.

## Contract

Auth: `X-Agent-Secret: <AGENT_SECRET>` on every request (must equal
`NODE_AGENT_SECRET` on the control plane).

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST   | `/peers`   | `{ publicKey, assignedIp, presharedKey?, remainingBytes? }` | add/refresh peer |
| DELETE | `/peers`   | `{ publicKey }` | remove peer |
| GET    | `/metrics` | — | `{ peers: [{ publicKey, rxBytes, txBytes, lastHandshake }] }` |

## Deploy / update

From your Mac, copy the agent to the node and restart it:

```bash
scp -i ~/.ssh/digitalocean_vpn_master node-agent/index.js root@<NODE_IP>:/opt/vpn-agent/index.js
ssh -i ~/.ssh/digitalocean_vpn_master root@<NODE_IP> 'systemctl restart vpn-agent'
```

Requires `node`, `express` (`cd /opt/vpn-agent && npm i express`), `nftables`
(`apt-get install -y nftables`), and a running `wg0` interface managed by
`wg-quick@wg0` (so `wg-quick save` can persist peers). The agent runs as `root`
so it can drive `wg` and `nft`.

## In-kernel quota enforcement (nftables)

`remainingBytes` (from `POST /peers`) is armed as a per-peer **`nftables` byte
quota** so the node drops the peer's traffic the instant it hits its allowance —
no round-trip to the control plane (BACKEND.md §6.3).

On startup the agent idempotently installs its own table — it never touches the
NAT/masquerade table, so forwarding and `MASQUERADE` are unaffected:

```
table inet wgquota {
  # one shared named quota per peer; RX+TX both accrue into it
  quota q_10_8_0_23 { over 5242880 bytes }

  chain forward {
    type filter hook forward priority 0; policy accept;
    # both directions point at the SAME quota => saddr + daddr counted together.
    # `over` + policy accept means we only DROP the exhausted flow, nothing else.
    ip saddr 10.8.0.23 quota name "q_10_8_0_23" drop
    ip daddr 10.8.0.23 quota name "q_10_8_0_23" drop
  }
}
```

- **Arm / reset:** `POST /peers` with a non-null `remainingBytes` deletes any
  existing rules + quota object for that IP and recreates them, so re-adding a
  peer **resets** the counter and never stacks rules (idempotent). Both a
  `saddr` and a `daddr` rule reference one named quota object, so `remainingBytes`
  is measured as **RX + TX combined**.
- **`remainingBytes: null` ⇒ unlimited** — no quota is armed (and any stale one
  for that IP is removed, e.g. after a premium upgrade).
- **Exhaustion:** the kernel drops immediately when `used ≥ bytes`. A periodic
  sweep (`QUOTA_SWEEP_INTERVAL_MS`, default 15s) then reads each quota's `over`
  state and, when over, runs `wg set wg0 peer <pk> remove` (so the tunnel drops
  and the app surfaces it) and tears down the peer's nft objects. The next
  `/metrics` poll reconciles the final delta into the control-plane ledger.
- **`DELETE /peers`** removes the peer's nft rules + quota object in addition to
  the wg peer.

Inspect live state on the node:

```bash
nft list table inet wgquota          # human-readable; shows `over` when exhausted
nft -j list table inet wgquota       # JSON (what the sweep parses: used vs bytes)
```

### Persistence & the reboot trade-off

The armed peer set is mirrored to `AGENT_STATE_FILE` (default
`/var/lib/vpn-agent/peers.json`, `0600`).

- **Agent restart** (kernel state intact): the sweep resumes against the live
  kernel counters untouched — quotas are **not** reset.
- **Reboot** (kernel nft state lost): on next start the agent re-arms remembered
  peers from their last-known budget. This is an approximation — the reboot loses
  the consumed counter, so a peer restored by `wg-quick` gets a fresh budget
  equal to its remaining bytes *at last connect*, not its live remaining. Reboots
  are rare, the Postgres ledger still refuses over-quota devices at `/sessions`,
  and the peer's next reconnect re-arms with the correct remaining. If you need
  exact survival across reboots, persist the ruleset instead
  (`systemctl enable nftables` + `nft list ruleset > /etc/nftables.conf`), at the
  cost of the counters (and `wg` transfer counters) still resetting on reboot.

## systemd unit (`/etc/systemd/system/vpn-agent.service`)

```ini
[Unit]
Description=VPN Master Node Agent
After=network.target wg-quick@wg0.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vpn-agent
Environment=AGENT_SECRET=<same value as NODE_AGENT_SECRET on Render>
# optional: Environment=WG_INTERFACE=wg0  Environment=AGENT_PORT=8080
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

`AGENT_SECRET` is unquoted here on purpose — systemd treats quotes as syntax, so
quotes would become part of the value and break auth.

## Hardening notes

- Inputs (`publicKey`, `assignedIp`, `presharedKey`) are strictly validated and
  passed to `wg` via `execFileSync` (no shell) — no command injection.
- PSKs are written to a `0600` temp file (never a shell arg) and unlinked.
- Peers persist across reboot via `wg-quick save`.
- **Control port is locked to the control plane (done):** TCP `AGENT_PORT`
  (8080) is firewalled to Render's outbound IP ranges; UDP 51820 (WireGuard)
  stays open to the world. See "Restricting the control port" below.
- **Still over plain HTTP (TODO):** the `X-Agent-Secret` travels unencrypted if
  `agent_url` is `http://`. Terminate TLS in front of the agent (e.g. a Caddy
  reverse proxy with a DNS name) and switch `agent_url` to `https://`.
- Inputs are also passed to `nft` via `execFileSync` argv arrays (no shell), so
  the quota path carries no command-injection surface either.
- **In-kernel quota enforcement is live** (see the section above) — the agent
  arms an `nftables` byte quota from `remainingBytes` and drops peers at the cap.

## Restricting the control port

The agent's HTTP port must only be reachable by the control plane. We enforce it
with a dedicated `nftables` table (its own hook, `policy accept`, so nothing else
is touched — SSH, WireGuard, forwarding, NAT and the `wgquota` table are all
unaffected; only TCP 8080 from a non-allowed source is dropped). Loopback is
allowed so on-box `curl 127.0.0.1:8080/metrics` checks keep working.

Render's static outbound IP ranges come from the service's **Connect → Outbound**
tab (Pro plan). As of setup: `74.220.48.0/24` and `74.220.56.0/24`.

`/etc/nftables/portfilter.nft` (the add-then-delete pair makes reloads idempotent
without flushing the global ruleset):

```
add table inet portfilter
delete table inet portfilter
table inet portfilter {
    chain input {
        type filter hook input priority 0; policy accept;
        iif "lo" accept
        tcp dport 8080 ip saddr { 74.220.48.0/24, 74.220.56.0/24 } accept
        tcp dport 8080 drop
    }
}
```

Persisted across reboot by a oneshot unit that re-applies only this table:

```ini
# /etc/systemd/system/agent-portfilter.service
[Unit]
Description=Agent control-port firewall (nftables inet portfilter)
After=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/nftables/portfilter.nft
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
```

Apply / enable:

```bash
nft -f /etc/nftables/portfilter.nft
systemctl enable --now agent-portfilter.service
```

If Render's outbound ranges ever change, edit the `saddr` set in
`portfilter.nft`, re-run `nft -f …`, and the change persists.

## Manual test log (real droplet)

Verifies the acceptance criteria on `192.34.58.185` (`wg0`, subnet `10.8.0.0/16`,
server pubkey `JXpZ1ezMQWeMF9AWDL+hJleMh2XvYvEPGBAsJHJmBXM=`). `nftables` can't be
tested off a real Linux WireGuard host, so this is the proof it works end-to-end.

The test spins up a **network-namespace WireGuard client** on the node itself
(the interface is created in the root netns so its UDP socket can reach `wg0`,
then moved into the netns for the inner traffic — the canonical single-host wg
test), arms a **5 MB** quota via the agent, and downloads a 10 MB file through
the tunnel. Recorded run:

```
=== 1. arm 5 MB quota via agent POST /peers ===
{"success":true}

=== 2. re-arm SAME peer (must RESET, not stack rules) ===
{"success":true}
--- wgquota table (ONE quota + exactly TWO rules for 10.8.0.222, used 0) ---
table inet wgquota {
	quota q_10_8_0_222 { over 5 mbytes }
	chain forward {
		type filter hook forward priority filter; policy accept;
		ip saddr 10.8.0.222 quota name "q_10_8_0_222" drop
		ip daddr 10.8.0.222 quota name "q_10_8_0_222" drop
	}
}

=== 3. netns client handshake ===
peer: JXpZ1ezMQWeMF9AWDL+hJleMh2XvYvEPGBAsJHJmBXM=
  latest handshake: Now

=== 4. download 10 MB THROUGH the tunnel (stalls ~5 MB) ===
downloaded=5052968 bytes  curl_exit=28        # kernel dropped it at ~5 MB

=== 5/6. agent sweep removes the peer ===
[agent] quota exhausted for 10.8.0.222 (5242880/5242880) — removing peer
REMOVED from wg0 (expected)
--- wgquota after sweep: peer's quota + rules torn down ---
table inet wgquota {
	chain forward { type filter hook forward priority filter; policy accept; }
}

=== 7. null remainingBytes => NO quota (unlimited, never limited) ===
{"success":true}
--- wgquota: no quota/rules for 10.8.0.222 ---
table inet wgquota { chain forward { ... policy accept; } }
```

Result vs. acceptance criteria:

- ✅ Kernel drops the peer's traffic at ~5 MB (download capped at 5,052,968 B;
  the quota hit `5242880/5242880` and went `over`).
- ✅ The peer is then removed from `wg show wg0` and its nft objects are freed.
- ✅ Re-adding an existing peer **resets** its counter (one quota + two rules, not
  stacked).
- ✅ A peer with `remainingBytes: null` gets no quota and is never limited.
- ✅ RX+TX are counted together (a single shared named quota, fed by both the
  `saddr` and `daddr` rules).

> **Ledger reconciliation note.** This run drove the agent directly, so there is
> no control-plane device row and `GET /v1/usage` does not move; the agent's
> `GET /metrics` is the exact RX+TX the usage poller ingests. In production the
> poller (every ~60s) accumulates the per-peer delta into the device's monthly
> counter, and `/v1/usage` then reflects it. Because the sweep removes an
> exhausted peer promptly, the delta between the last poll and removal (bounded
> by the poll interval) may go unrecorded — the *kernel* cap, not the poll, is
> what actually stopped the traffic (BACKEND.md §6.3.5). To surface the literal
> `/v1/usage` number end-to-end, register this node as a `provisioner='agent'`
> server (with `agent_url`) and provision the peer through `POST /v1/sessions`.
