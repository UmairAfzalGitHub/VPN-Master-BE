#!/usr/bin/env bash
#
# common.sh — shared helpers for the VPN Master node automation scripts.
# Source this from the top of each script:  source "$(dirname "$0")/lib/common.sh"
#
# Provides: colored logging, a step counter, output verification with detailed
# failure dumps, secure prompts, and SSH/SCP wrappers to the droplet.

# --- Colors (disabled when not a TTY or NO_COLOR is set) --------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

# --- Step counter -----------------------------------------------------------
STEP_TOTAL="${STEP_TOTAL:-0}"
STEP_N=0

# --- Logging ----------------------------------------------------------------
log_info()  { printf '%s\n' "${C_DIM}·${C_RESET} $*"; }
log_ok()    { printf '%s\n' "  ${C_GREEN}✓${C_RESET} $*"; }
log_warn()  { printf '%s\n' "  ${C_YELLOW}!${C_RESET} $*" >&2; }
log_err()   { printf '%s\n' "${C_RED}✗ $*${C_RESET}" >&2; }

# step "Description" — prints a numbered header
step() {
  STEP_N=$((STEP_N + 1))
  if [[ "$STEP_TOTAL" -gt 0 ]]; then
    printf '\n%s▸ [%s/%s]%s %s\n' "$C_BOLD$C_BLUE" "$STEP_N" "$STEP_TOTAL" "$C_RESET" "${C_BOLD}$*$C_RESET"
  else
    printf '\n%s▸%s %s\n' "$C_BOLD$C_BLUE" "$C_RESET" "${C_BOLD}$*$C_RESET"
  fi
}

# banner "Title" — a section separator
banner() {
  printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '%s  %s%s\n'  "$C_BOLD$C_CYAN" "$*" "$C_RESET"
  printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
}

# die "message" [captured-output] [hint]
# Prints a red failure box with the captured output and an optional hint, exits 1.
die() {
  local msg="$1" output="${2:-}" hint="${3:-}"
  printf '\n%s┌─ STEP FAILED ────────────────────────────────────────────────%s\n' "$C_RED" "$C_RESET" >&2
  printf '%s│%s %s\n' "$C_RED" "$C_RESET" "$msg" >&2
  if [[ -n "$output" ]]; then
    printf '%s│%s %s─ captured output ─%s\n' "$C_RED" "$C_RESET" "$C_DIM" "$C_RESET" >&2
    while IFS= read -r line; do printf '%s│%s   %s\n' "$C_RED" "$C_RESET" "$line" >&2; done <<< "$output"
  fi
  if [[ -n "$hint" ]]; then
    printf '%s│%s %s→ %s%s\n' "$C_RED" "$C_RESET" "$C_YELLOW" "$hint" "$C_RESET" >&2
  fi
  printf '%s└──────────────────────────────────────────────────────────────%s\n' "$C_RED" "$C_RESET" >&2
  exit 1
}

# verify <output> <pattern> <fail-msg> [hint] — grep the pattern or die with the output
verify() {
  local output="$1" pattern="$2" msg="$3" hint="${4:-}"
  if ! grep -qE "$pattern" <<< "$output"; then
    die "$msg" "$output" "$hint"
  fi
}

# --- Prompts ----------------------------------------------------------------
# prompt VAR "Question" ["default"] — visible input, optional default
prompt() {
  local __var="$1" q="$2" def="${3:-}" ans
  if [[ -n "$def" ]]; then
    read -r -p "$(printf '%s?%s %s %s[%s]%s ' "$C_CYAN" "$C_RESET" "$q" "$C_DIM" "$def" "$C_RESET")" ans
    ans="${ans:-$def}"
  else
    read -r -p "$(printf '%s?%s %s ' "$C_CYAN" "$C_RESET" "$q")" ans
  fi
  printf -v "$__var" '%s' "$ans"
}

# prompt_secret VAR "Question" — hidden input (not echoed, not in history)
prompt_secret() {
  local __var="$1" q="$2" ans
  read -r -s -p "$(printf '%s?%s %s ' "$C_CYAN" "$C_RESET" "$q")" ans
  printf '\n'
  printf -v "$__var" '%s' "$ans"
}

# confirm "Question" — returns 0 on yes
confirm() {
  local q="$1" ans
  read -r -p "$(printf '%s?%s %s %s[y/N]%s ' "$C_CYAN" "$C_RESET" "$q" "$C_DIM" "$C_RESET")" ans
  [[ "$ans" =~ ^[Yy]$ || "$ans" =~ ^[Yy][Ee][Ss]$ ]]
}

# --- SSH / SCP wrappers -----------------------------------------------------
# Require NODE_IP and SSH_KEY to be set before use.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

ssh_do() {  # ssh_do "<remote command>"   → runs on the droplet, returns its output
  ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@${NODE_IP}" "$1"
}

ssh_pipe() {  # printf ... | ssh_pipe "<remote command reading stdin>"
  ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@${NODE_IP}" "$1"
}

scp_up()   { scp -i "$SSH_KEY" "${SSH_OPTS[@]}" "$1" "root@${NODE_IP}:$2"; }
scp_down() { scp -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@${NODE_IP}:$1" "$2"; }

# --- Misc -------------------------------------------------------------------
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }

# Resolve the repo root from this lib's location (scripts/lib/common.sh -> repo root)
repo_root() { cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd; }
