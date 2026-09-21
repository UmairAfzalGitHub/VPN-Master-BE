#!/usr/bin/env bash
#
# provision-node.sh — HALF A of the add-a-server runbook, automated.
#
# Stands up a brand-new DigitalOcean droplet as a WireGuard VPN node: installs
# WireGuard + the node-agent, generates keys and a TLS cert, wires up systemd
# and the firewall, and smoke-tests the agent — all over SSH from your Mac.
#
# You create the droplet in the DigitalOcean dashboard first, then run this and
# paste its IP. It verifies the output of every step and aborts with a detailed
# log if anything looks wrong.
#
# Usage:   ./scripts/provision-node.sh
#          (run from the repo root; it will prompt for everything it needs)
#
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

REPO="$(repo_root)"
cd "$REPO"
STEP_TOTAL=13

banner "VPN Master · Provision a new node (Half A)"

# ---------------------------------------------------------------------------
step "Preflight — collect inputs and check tools"
# ---------------------------------------------------------------------------
need_cmd ssh; need_cmd scp; need_cmd openssl

SSH_KEY="${SSH_KEY:-$HOME/.ssh/digitalocean_vpn_master}"
[[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY" "" "Set SSH_KEY=/path/to/key and re-run."
[[ -f "$REPO/node-agent/index.js" ]] || die "node-agent/index.js not found — are you in the VPN-Master-BE repo?"

prompt NODE_IP    "Droplet public IP"
[[ "$NODE_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "That doesn't look like an IPv4 address: $NODE_IP"

prompt SERVER_ID  "Server ID (e.g. gb-lon-01)"
[[ "$SERVER_ID" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || log_warn "Unusual server id '$SERVER_ID' (expected like gb-lon-01) — continuing."

# Suggest the next free /16 by scanning existing migrations.
used_max="$(grep -rhoE '10\.[0-9]+\.0\.0/16' db/migrations 2>/dev/null | awk -F. '{print $2}' | sort -n | tail -1)"
suggest_subnet="10.$(( ${used_max:-10} + 1 )).0.0/16"
prompt SUBNET     "Tunnel subnet (unique /16 — see runbook §2)" "$suggest_subnet"
[[ "$SUBNET" =~ ^10\.[0-9]+\.0\.0/16$ ]] || die "Subnet must look like 10.x.0.0/16 (got: $SUBNET)"
SUBNET_GW="${SUBNET%.0.0/16}.0.1/16"   # 10.13.0.0/16 -> 10.13.0.1/16
CN="vpn-agent-${SERVER_ID}"

prompt_secret NODE_AGENT_SECRET "NODE_AGENT_SECRET (from Render → Environment; hidden)"
[[ -n "$NODE_AGENT_SECRET" ]] || die "NODE_AGENT_SECRET cannot be empty."

DEFAULT_RANGES="74.220.48.0/24,74.220.56.0/24"
prompt RENDER_RANGES "Render outbound ranges for :8443 (comma-sep; Render → Connect → Outbound)" "$DEFAULT_RANGES"

printf '\n'
log_info "Node IP     : $NODE_IP"
log_info "Server ID   : $SERVER_ID"
log_info "Subnet      : $SUBNET  (gateway $SUBNET_GW)"
log_info "Cert CN     : $CN"
log_info "Render ranges: $RENDER_RANGES"
confirm "Proceed with these values?" || { log_warn "Aborted by user."; exit 0; }

# Connectivity check
out="$(ssh_do 'echo ok' 2>&1)" || die "Cannot SSH into root@$NODE_IP" "$out" \
  "Check the IP, that the droplet is up, and that $SSH_KEY is the right key."
verify "$out" '^ok$' "SSH connected but returned unexpected output" "$out"
log_ok "SSH to root@$NODE_IP works"

# ---------------------------------------------------------------------------
step "Install WireGuard + node + enable IP forwarding"
# ---------------------------------------------------------------------------
out="$(ssh_do "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard nftables nodejs npm && echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-wg.conf && sysctl --system && echo DONE_INSTALL" 2>&1)" \
  || die "Package install failed" "$out"
verify "$out" 'DONE_INSTALL' "Install did not complete" "$out"
log_ok "Packages installed, IP forwarding enabled"

# ---------------------------------------------------------------------------
step "Generate the WireGuard keypair"
# ---------------------------------------------------------------------------
out="$(ssh_do "cd /etc/wireguard && umask 077 && wg genkey | tee server.key | wg pubkey > server.pub && cat server.pub" 2>&1)" \
  || die "Key generation failed" "$out"
PUBLIC_KEY="$(tail -n1 <<< "$out" | tr -d '[:space:]')"
[[ "$PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{42,44}=$ ]] || die "Public key looks wrong: '$PUBLIC_KEY'" "$out"
log_ok "Public key: $PUBLIC_KEY"

# ---------------------------------------------------------------------------
step "Detect interface + write wg0.conf"
# ---------------------------------------------------------------------------
IFACE="$(ssh_do "ip route | awk '/default/ {print \$5; exit}'" 2>&1 | tr -d '[:space:]')"
[[ -n "$IFACE" ]] || die "Could not detect the default network interface"
log_info "Default interface: $IFACE"
out="$(ssh_do "cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = ${SUBNET_GW}
PostUp = iptables -I FORWARD 1 -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o ${IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o ${IFACE} -j MASQUERADE
ListenPort = 51820
PrivateKey = \$(cat /etc/wireguard/server.key)
EOF
echo DONE_CONF" 2>&1)" || die "Writing wg0.conf failed" "$out"
verify "$out" 'DONE_CONF' "wg0.conf not written" "$out"
log_ok "wg0.conf written (Address ${SUBNET_GW}, iface ${IFACE})"

# ---------------------------------------------------------------------------
step "Bring up wg0 and verify"
# ---------------------------------------------------------------------------
out="$(ssh_do "systemctl enable --now wg-quick@wg0 && wg show && iptables -L FORWARD -n -v --line-numbers | head -3" 2>&1)" \
  || die "wg-quick@wg0 failed to start" "$out" \
     "Most often a bad Address in wg0.conf. Check: journalctl -xeu wg-quick@wg0"
verify "$out" 'listening port: 51820' "wg0 is not listening on 51820" "$out" "See runbook T2."
verify "$out" 'ACCEPT.*wg0'            "FORWARD accept rule for wg0 missing" "$out" "See runbook T2."
log_ok "wg0 up, listening on 51820, FORWARD rule in place"

# ---------------------------------------------------------------------------
step "Deploy the node-agent code"
# ---------------------------------------------------------------------------
ssh_do "mkdir -p /opt/vpn-agent" >/dev/null 2>&1 || die "Could not create /opt/vpn-agent"
scp_up "$REPO/node-agent/index.js" "/opt/vpn-agent/index.js" >/dev/null 2>&1 \
  || die "scp of node-agent/index.js failed"
out="$(ssh_do "cd /opt/vpn-agent && npm i express 2>&1 && echo DONE_NPM" 2>&1)" \
  || die "npm i express failed" "$out"
verify "$out" 'DONE_NPM' "npm install did not finish" "$out"
log_ok "Agent code deployed, express installed"

# ---------------------------------------------------------------------------
step "Generate the agent TLS cert (IP-SAN)"
# ---------------------------------------------------------------------------
out="$(ssh_do "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout /opt/vpn-agent/agent.key -out /opt/vpn-agent/agent.crt -days 3650 \
  -subj '/CN=${CN}' -addext 'subjectAltName=IP:${NODE_IP},IP:127.0.0.1' 2>&1 \
  && chmod 600 /opt/vpn-agent/agent.key && echo DONE_CERT" 2>&1)" \
  || die "openssl cert generation failed" "$out"
verify "$out" 'DONE_CERT' "Cert not generated" "$out"
log_ok "TLS cert generated (CN=${CN}, SAN IP:${NODE_IP})"

# ---------------------------------------------------------------------------
step "Pull the public cert into the repo"
# ---------------------------------------------------------------------------
mkdir -p "$REPO/certs"
CERT_PATH="certs/${SERVER_ID}-agent.crt"
scp_down "/opt/vpn-agent/agent.crt" "$REPO/$CERT_PATH" >/dev/null 2>&1 \
  || die "Could not pull agent.crt into the repo"
san="$(openssl x509 -in "$REPO/$CERT_PATH" -noout -ext subjectAltName 2>&1)"
verify "$san" "IP Address:${NODE_IP}" "Cert SAN does not include the node IP" "$san"
log_ok "Cert saved to $CERT_PATH (SAN verified)"

# ---------------------------------------------------------------------------
step "Install the systemd unit (secret injected securely)"
# ---------------------------------------------------------------------------
# Build the unit text locally WITH the secret, then pipe it to the droplet over
# the encrypted SSH channel straight into the file — the secret never appears in
# argv, in shell history, or on local disk.
UNIT_TEXT="[Unit]
Description=VPN Master Node Agent
After=network.target wg-quick@wg0.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vpn-agent
Environment=AGENT_SECRET=${NODE_AGENT_SECRET}
Environment=TLS_CERT_FILE=/opt/vpn-agent/agent.crt
Environment=TLS_KEY_FILE=/opt/vpn-agent/agent.key
Environment=AGENT_TLS_PORT=8443
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target"
printf '%s\n' "$UNIT_TEXT" | ssh_pipe "cat > /etc/systemd/system/vpn-agent.service && echo DONE_UNIT" >/dev/null 2>&1 \
  || die "Could not write the systemd unit"
log_ok "vpn-agent.service installed"

# ---------------------------------------------------------------------------
step "Start the agent and verify it stays up"
# ---------------------------------------------------------------------------
ssh_do "systemctl daemon-reload && systemctl enable --now vpn-agent" >/dev/null 2>&1 \
  || die "Failed to start vpn-agent"
sleep 3
out="$(ssh_do "systemctl is-active vpn-agent; systemctl show vpn-agent -p MainPID --value; journalctl -u vpn-agent -n 15 --no-pager" 2>&1)" \
  || die "Could not read vpn-agent status" "$out"
verify "$out" '^active'                 "vpn-agent is not active" "$out" "See runbook T5 (bad/quoted AGENT_SECRET)."
verify "$out" 'VPN Agent HTTPS on port 8443' "Agent did not report listening on 8443" "$out" "See runbook T5."
log_ok "vpn-agent active and listening on 8443"

# ---------------------------------------------------------------------------
step "Apply the firewall (lock :8443 to Render)"
# ---------------------------------------------------------------------------
ufw_cmds="ufw allow 22/tcp && ufw allow 51820/udp"
IFS=',' read -ra RANGES <<< "$RENDER_RANGES"
for r in "${RANGES[@]}"; do
  r="$(tr -d '[:space:]' <<< "$r")"
  ufw_cmds+=" && ufw allow from ${r} to any port 8443 proto tcp"
done
ufw_cmds+=" && echo y | ufw enable && ufw status verbose"
out="$(ssh_do "$ufw_cmds" 2>&1)" || die "Applying ufw rules failed" "$out"
verify "$out" 'Status: active' "ufw did not activate" "$out"
verify "$out" '8443/tcp'       "8443 rule not present in ufw" "$out" "See runbook T3."
log_ok "Firewall active (22, 51820 open; 8443 limited to Render)"

# ---------------------------------------------------------------------------
step "Smoke-test the agent over TLS on the box"
# ---------------------------------------------------------------------------
out="$(ssh_do 'SECRET=$(systemctl show vpn-agent -p Environment --value | tr " " "\n" | sed -n "s/^AGENT_SECRET=//p"); curl -s --cacert /opt/vpn-agent/agent.crt https://127.0.0.1:8443/metrics -H "X-Agent-Secret: $SECRET"; echo; nft list table inet wgquota' 2>&1)" \
  || die "Smoke test failed to run" "$out"
verify "$out" '"peers"' "Agent /metrics did not return a peers list" "$out" "See runbook T5."
verify "$out" 'table inet wgquota' "wgquota nft table missing" "$out"
log_ok "Agent responds over TLS; wgquota table present"

# ---------------------------------------------------------------------------
step "Save state for the BE registration step"
# ---------------------------------------------------------------------------
mkdir -p "$REPO/scripts/.state"
STATE="$REPO/scripts/.state/${SERVER_ID}.env"
cat > "$STATE" <<EOF
# Written by provision-node.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
SERVER_ID=${SERVER_ID}
NODE_IP=${NODE_IP}
SUBNET=${SUBNET}
SUBNET_GW=${SUBNET_GW}
PUBLIC_KEY=${PUBLIC_KEY}
IFACE=${IFACE}
EOF
log_ok "State saved to scripts/.state/${SERVER_ID}.env (gitignored)"

banner "✓ Half A complete — $SERVER_ID is a live WireGuard node"
printf '%s\n' "Next: register it in the control plane:"
printf '%s\n' "  ${C_BOLD}./scripts/activate-node.sh ${SERVER_ID}${C_RESET}"
printf '%s\n' "Then push (you deploy), then verify:"
printf '%s\n' "  ${C_BOLD}git push${C_RESET}   then   ${C_BOLD}./scripts/verify-node.sh ${SERVER_ID}${C_RESET}"
