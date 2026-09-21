#!/usr/bin/env bash
#
# verify-node.sh — HALF B verification (runbook steps 20–22).
#
# Run this AFTER you've pushed and Render has finished deploying. Confirms the
# node is live end-to-end: it shows in the catalog, a real session provisions a
# peer over TLS, and that peer actually landed in the droplet's kernel.
#
# Usage:   ./scripts/verify-node.sh [server-id]
#
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

REPO="$(repo_root)"
cd "$REPO"
STEP_TOTAL=3

CONTROL_URL="${CONTROL_URL:-https://nyx-edge.onrender.com}"

banner "VPN Master · Verify a live node (Half B, steps 20–22)"

need_cmd curl; need_cmd jq

SERVER_ID="${1:-}"
[[ -z "$SERVER_ID" ]] && prompt SERVER_ID "Server ID to verify (e.g. gb-lon-01)"

STATE="$REPO/scripts/.state/${SERVER_ID}.env"
if [[ -f "$STATE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE"
  log_ok "Loaded scripts/.state/${SERVER_ID}.env"
else
  prompt NODE_IP "Node public IP"
  prompt SUBNET  "Tunnel subnet (10.x.0.0/16)"
fi

SSH_KEY="${SSH_KEY:-$HOME/.ssh/digitalocean_vpn_master}"
prompt_secret API_KEY "API_KEYS value (from Render → Environment; hidden)"
[[ -n "$API_KEY" ]] || die "API key cannot be empty."

subnet_prefix="$(awk -F. '{print $1"."$2}' <<< "$SUBNET")"   # e.g. 10.13

# ---------------------------------------------------------------------------
step "Catalog shows the real node"
# ---------------------------------------------------------------------------
out="$(curl -sS "${CONTROL_URL}/v1/servers" -H "X-API-Key: ${API_KEY}" 2>&1)" \
  || die "Could not reach ${CONTROL_URL}/v1/servers" "$out" "See runbook T1 (wrong URL / service not live)."
row="$(jq -e ".[] | select(.id==\"${SERVER_ID}\")" <<< "$out" 2>/dev/null)" \
  || die "Server '${SERVER_ID}' not found in the catalog" "$out" "Did the migration run? Check Render deploy logs."
verify "$row" "${NODE_IP}:51820" "Catalog endpoint is not ${NODE_IP}:51820" "$row"
log_ok "Catalog lists ${SERVER_ID} with endpoint ${NODE_IP}:51820"

# ---------------------------------------------------------------------------
step "A real session provisions a peer over TLS"
# ---------------------------------------------------------------------------
fake_pub="$(head -c32 /dev/urandom | base64)"
out="$(curl -sS -w $'\n%{http_code}' -X POST "${CONTROL_URL}/v1/sessions" \
  -H "X-API-Key: ${API_KEY}" -H 'Content-Type: application/json' \
  -d "{\"serverID\":\"${SERVER_ID}\",\"publicKey\":\"${fake_pub}\"}" 2>&1)" \
  || die "Session request failed to send" "$out"
code="$(tail -n1 <<< "$out")"; body="$(sed '$d' <<< "$out")"
[[ "$code" == "200" ]] || die "Session returned HTTP ${code} (expected 200)" "$body" \
  "See runbook T3 (control plane can't reach the agent — check ufw ranges)."
verify "$body" "assignedAddresses" "Response missing assignedAddresses" "$body"
verify "$body" "${subnet_prefix}\\." "Assigned address is not in ${subnet_prefix}.x" "$body"
log_ok "Session HTTP 200; peer assigned an address in ${subnet_prefix}.x"

# ---------------------------------------------------------------------------
step "The peer landed in the droplet's kernel"
# ---------------------------------------------------------------------------
[[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY (needed for the kernel check)"
out="$(ssh_do 'wg show wg0 | sed -n "/peer:/,\$p"; nft list table inet wgquota' 2>&1)" \
  || die "Could not SSH to the droplet for the kernel check" "$out"
verify "$out" 'peer:' "No peer present on wg0 yet" "$out"
verify "$out" 'allowed ips'    "Peer has no allowed-ips" "$out"
log_ok "Peer present on wg0 with an allowed-ip; wgquota armed"

banner "✓ ${SERVER_ID} is production-live"
printf '%s\n' "It now appears as a connectable server in the iOS app."
printf '%s\n' "The test peer has no handshake, so the reaper auto-removes it within"
printf '%s\n' "PEER_TTL_MINUTES (30). Nothing to clean up."
