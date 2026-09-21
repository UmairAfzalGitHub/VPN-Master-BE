#!/usr/bin/env bash
#
# activate-node.sh — HALF B of the add-a-server runbook, automated (steps 17–18).
#
# Registers a provisioned node in the control plane: writes the next DB migration
# (UPDATE for a seed row, INSERT for a brand-new region), updates the §2 subnet
# registry in the runbook, and commits — all in the repo, no droplet access.
#
# It does NOT push. You review and `git push` yourself to trigger the Render
# deploy, then run ./scripts/verify-node.sh <server-id>.
#
# Usage:   ./scripts/activate-node.sh [server-id]
#          (reads scripts/.state/<id>.env from provision-node.sh; prompts for
#           anything missing)
#
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

REPO="$(repo_root)"
cd "$REPO"
STEP_TOTAL=5

banner "VPN Master · Register a node in the control plane (Half B)"

# ---------------------------------------------------------------------------
step "Load node details"
# ---------------------------------------------------------------------------
need_cmd git; need_cmd python3

SERVER_ID="${1:-}"
[[ -z "$SERVER_ID" ]] && prompt SERVER_ID "Server ID to activate (e.g. gb-lon-01)"

STATE="$REPO/scripts/.state/${SERVER_ID}.env"
if [[ -f "$STATE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE"
  log_ok "Loaded scripts/.state/${SERVER_ID}.env"
else
  log_warn "No state file for $SERVER_ID — you'll enter the values manually."
  prompt NODE_IP    "Node public IP"
  prompt SUBNET     "Tunnel subnet (10.x.0.0/16)"
  prompt PUBLIC_KEY "Node WireGuard public key"
fi
[[ -n "${NODE_IP:-}" && -n "${SUBNET:-}" && -n "${PUBLIC_KEY:-}" ]] \
  || die "Missing NODE_IP / SUBNET / PUBLIC_KEY — cannot build the migration."

# Is this an existing seed row (UPDATE) or a new region (INSERT)?
if grep -q "'${SERVER_ID}'" db/migrations/002_seed_servers.sql 2>/dev/null; then
  MODE="update"; log_info "Mode: UPDATE (found '${SERVER_ID}' in the seed)"
else
  MODE="insert"; log_info "Mode: INSERT (new region, not in the seed)"
fi

# Registry label (city) and, for INSERT, the full catalog fields.
DEFAULT_CITY="$(printf '%s' "${SERVER_ID#*-}" | cut -d- -f1 | tr '[:lower:]' '[:upper:]')"
prompt REG_LABEL "Registry/display city label" "$DEFAULT_CITY"
if [[ "$MODE" == "insert" ]]; then
  prompt SRV_NAME    "Display name" "$REG_LABEL"
  prompt SRV_COUNTRY "Country" ""
  prompt SRV_CC      "Country code (ISO alpha-2, e.g. GB)" ""
  prompt SRV_CITY    "City" "$REG_LABEL"
fi

printf '\n'
log_info "Server ID : $SERVER_ID   ($MODE)"
log_info "Endpoint  : ${NODE_IP}:51820"
log_info "Subnet    : $SUBNET"
log_info "Public key: $PUBLIC_KEY"
confirm "Generate the migration and commit?" || { log_warn "Aborted."; exit 0; }

# ---------------------------------------------------------------------------
step "Write the migration"
# ---------------------------------------------------------------------------
last_num="$(ls db/migrations/ | grep -oE '^[0-9]{3}' | sort -n | tail -1)"
next_num="$(printf '%03d' "$(( 10#${last_num} + 1 ))")"
id_us="${SERVER_ID//-/_}"
MIG="db/migrations/${next_num}_activate_${id_us}.sql"

if [[ "$MODE" == "update" ]]; then
  cat > "$MIG" <<EOF
-- Activate the real ${REG_LABEL} node (${SERVER_ID}) — flip it from the
-- placeholder 'mock' seed (migration 002) to a live 'agent' node backed by a
-- DigitalOcean droplet. Idempotent: 002 always seeds the row; this UPDATE just
-- points it at the real host, so it survives a DB recreation.
--
-- public_key / endpoint / agent_url are operational, non-secret values.
-- tunnel_subnet ${SUBNET} is unique to this node (see runbook §2).

UPDATE servers
SET endpoint      = '${NODE_IP}:51820',
    public_key    = '${PUBLIC_KEY}',
    tunnel_subnet = '${SUBNET}',
    provisioner   = 'agent',
    agent_url     = 'https://${NODE_IP}:8443',
    enabled       = true,
    updated_at    = now()
WHERE id = '${SERVER_ID}';
EOF
else
  cat > "$MIG" <<EOF
-- Add + activate the new region ${SERVER_ID} (${REG_LABEL}) as a live 'agent'
-- node. Idempotent via ON CONFLICT so it survives a DB recreation.
-- tunnel_subnet ${SUBNET} is unique to this node (see runbook §2).

INSERT INTO servers
  (id, name, country, country_code, city, endpoint, public_key,
   tunnel_subnet, load, is_premium, provisioner, agent_url, enabled)
VALUES
  ('${SERVER_ID}', '${SRV_NAME}', '${SRV_COUNTRY}', '${SRV_CC}', '${SRV_CITY}',
   '${NODE_IP}:51820', '${PUBLIC_KEY}', '${SUBNET}', 0.30, false,
   'agent', 'https://${NODE_IP}:8443', true)
ON CONFLICT (id) DO UPDATE SET
  endpoint = EXCLUDED.endpoint, public_key = EXCLUDED.public_key,
  tunnel_subnet = EXCLUDED.tunnel_subnet, provisioner = EXCLUDED.provisioner,
  agent_url = EXCLUDED.agent_url, enabled = EXCLUDED.enabled, updated_at = now();
EOF
fi
log_ok "Wrote $MIG"

# ---------------------------------------------------------------------------
step "Update the §2 subnet registry (best-effort)"
# ---------------------------------------------------------------------------
# Compute the next /16 to promote to "next free".
octet="$(awk -F. '{print $2}' <<< "$SUBNET")"
NEXT_SUBNET="10.$(( octet + 1 )).0.0/16"

replace_literal() { # <file> <old> <new>  → exit 2 if <old> not found
  python3 - "$@" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
if old not in s:
    sys.exit(2)
open(path, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
}

patch_registry() { # <file> <mode: md|html>
  local file="$1" kind="$2" rc1 rc2
  [[ -f "$file" ]] || { log_warn "$file not found — skipping registry patch."; return; }
  if [[ "$kind" == "md" ]]; then
    replace_literal "$file" \
      "| \`${SUBNET}\` | ← next free — use this for your new node |" \
      "| \`${SUBNET}\` | \`${SERVER_ID}\` (${REG_LABEL}) |"; rc1=$?
    replace_literal "$file" \
      "| \`${NEXT_SUBNET}\` | free |" \
      "| \`${NEXT_SUBNET}\` | ← next free — use this for your new node |"; rc2=$?
  else
    replace_literal "$file" \
      "<tr><td><code>${SUBNET}</code></td><td class=\"next\">← next free — use this for your new node</td></tr>" \
      "<tr><td><code>${SUBNET}</code></td><td><code>${SERVER_ID}</code> (${REG_LABEL})</td></tr>"; rc1=$?
    replace_literal "$file" \
      "<tr><td><code>${NEXT_SUBNET}</code></td><td class=\"free\">free</td></tr>" \
      "<tr><td><code>${NEXT_SUBNET}</code></td><td class=\"next\">← next free — use this for your new node</td></tr>"; rc2=$?
  fi
  if [[ "${rc1:-1}" -eq 0 ]]; then
    log_ok "Patched registry in $(basename "$file")"
  else
    log_warn "Could not auto-patch $(basename "$file") — update §2 by hand for ${SUBNET} → ${SERVER_ID}."
  fi
}

patch_registry "docs/RUNBOOK-add-server.md"   md
patch_registry "docs/RUNBOOK-add-server.html" html

# ---------------------------------------------------------------------------
step "Commit (no push)"
# ---------------------------------------------------------------------------
git add "$MIG" "certs/${SERVER_ID}-agent.crt" docs/RUNBOOK-add-server.md docs/RUNBOOK-add-server.html 2>/dev/null || true
if git diff --cached --quiet; then
  die "Nothing staged to commit — did the cert / migration get created?"
fi
git commit -q -m "servers: activate ${SERVER_ID} (real WireGuard node, ${REG_LABEL})" \
  -m "endpoint ${NODE_IP}:51820, tunnel_subnet ${SUBNET}; migration ${next_num}." \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
log_ok "Committed: servers: activate ${SERVER_ID}"

banner "✓ Half B staged — review, then push to deploy"
git --no-pager show --stat HEAD | sed 's/^/  /'
printf '\n%s\n' "When you're ready to deploy:"
printf '%s\n' "  ${C_BOLD}git push${C_RESET}"
printf '%s\n' "Then verify the live node:"
printf '%s\n' "  ${C_BOLD}./scripts/verify-node.sh ${SERVER_ID}${C_RESET}"
