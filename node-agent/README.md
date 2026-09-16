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

Requires `node`, `express` (`cd /opt/vpn-agent && npm i express`), and a running
`wg0` interface managed by `wg-quick@wg0` (so `wg-quick save` can persist peers).

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
- **Expose only what's needed:** the firewall should allow UDP 51820
  (WireGuard) to the world, but restrict TCP `AGENT_PORT` (8080) to the control
  plane, and put it behind TLS. The `X-Agent-Secret` currently travels over
  plain HTTP if `agent_url` is `http://`.
- **Not yet implemented:** in-kernel `nftables` byte-quota enforcement from
  `remainingBytes` (BACKEND.md 6.3). The agent accepts the field but does not
  enforce it — quota is bookkeeping-only until this lands.
```
