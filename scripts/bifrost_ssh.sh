#!/usr/bin/env bash
# Sync project to a Linux host over SSH (optional), then run systemctl on selected units (optional).
#
# See usage() or: ./scripts/bifrost_ssh.sh --help
#
# Bash 3.2 (macOS) + set -u: avoid expanding empty arrays with "${arr[@]}" — use length checks first.
#
# Interactive mode (no args, or -i/--interactive): SSH ControlMaster — SSH login once (unless using keys);
# sudo password is kept in memory for the whole session (sudo -S) until quit or menu tl2 Clear.
# Menu db1 DB refresh / db2 lock release: choose Dev (local --dev) or Prod (remote --prod); no need to exit SSH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEPLOY_HOST="${DEPLOY_HOST:-192.168.10.70}"
DEPLOY_USER="${DEPLOY_USER:-vision}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/vision/bifrost-trader-engine}"

# Set by interactive mode: multiplexed SSH socket (no password file; reuse one authenticated session).
SSH_CONTROL_PATH=""
# Optional: remote sudo password for this process only (never written to disk).
# May be preset via --password / -p / DEPLOY_SUDO_PASSWORD before interactive prompt.
SUDO_PASSWORD=""
# Interactive mode: backup of the sudo password for the whole script run (re-applied before each remote step).
BIFROST_SESSION_SUDO_PASSWORD=""

DO_DEPLOY=0
DO_DEPLOY_ONLY=0
DO_MIGRATE=0
SYNC_PROD_CONFIG="${DEPLOY_SYNC_PROD_CONFIG:-0}"
RESTART_ALL=0
ACTION=""
DO_STATUS=0
# When 1, systemctl targets full stack: all HTTP APIs + bifrost-agent + Socket Services ingest units (no bifrost-celery; no bifrost-engine — Engine start/stop via Ops UI like Socket Services).
RESTART_ALL_STACK=0
# When 1, systemctl targets all FastAPI units only (Monitor + domain APIs).
RESTART_ALL_APIS=0
# Single category for CLI/--category (architecture|account|research|feed); empty = not used.
RESTART_CATEGORY=""
# Ops taxonomy: four HTTP groups (see ARCHITECTURE §4.0, bifrost_ssh.sh usage).
BIFROST_CATEGORY_ARCHITECTURE=(bifrost-server bifrost-ops bifrost-docs)
BIFROST_CATEGORY_ACCOUNT=(bifrost-trading bifrost-portfolio)
BIFROST_CATEGORY_RESEARCH=(bifrost-market bifrost-research bifrost-strategy)
BIFROST_CATEGORY_FEED=(bifrost-massive)
# Socket-side ingest / IB edge (systemd; Ops "Socket Services"; whitelist in backend/ops/agent/protocol.py).
BIFROST_CATEGORY_SOCKET_SERVICES=(
  bifrost-massive-ws
  bifrost-ib-operator
  bifrost-ib-ingestor
  bifrost-ib-account-agent
)
# All HTTP API units (9): derived from categories — do not list twice elsewhere.
BIFROST_HTTP_UNITS=(
  "${BIFROST_CATEGORY_ARCHITECTURE[@]}"
  "${BIFROST_CATEGORY_ACCOUNT[@]}"
  "${BIFROST_CATEGORY_RESEARCH[@]}"
  "${BIFROST_CATEGORY_FEED[@]}"
)
# Full prod stack for this script (restart/deploy): monitor, other HTTP APIs, agent, Socket Services — excludes bifrost-engine (Ops UI).
BIFROST_FULL_STACK_UNITS=(bifrost-server)
for _u in "${BIFROST_HTTP_UNITS[@]}"; do
  [[ "${_u}" == bifrost-server ]] && continue
  BIFROST_FULL_STACK_UNITS+=("${_u}")
done
BIFROST_FULL_STACK_UNITS+=(bifrost-agent)
BIFROST_FULL_STACK_UNITS+=(bifrost-account-sync)
BIFROST_FULL_STACK_UNITS+=("${BIFROST_CATEGORY_SOCKET_SERVICES[@]}")
# TUI status / --status: HTTP by category order, Socket Services, then Daemon (engine+agent+account-sync; no bifrost-celery — use Ops UI).
BIFROST_STATUS_ROWS=(
  "${BIFROST_CATEGORY_ARCHITECTURE[@]}"
  "${BIFROST_CATEGORY_ACCOUNT[@]}"
  "${BIFROST_CATEGORY_RESEARCH[@]}"
  "${BIFROST_CATEGORY_FEED[@]}"
  "${BIFROST_CATEGORY_SOCKET_SERVICES[@]}"
  bifrost-engine
  bifrost-agent
  bifrost-account-sync
)
# Remote --remote-services-status / menu tl5: sectioned scan (see _cli_remote_services_systemd_scan); flat list for reference only.
BIFROST_REMOTE_SCAN_UNITS=(
  bifrost-server bifrost-engine bifrost-celery
  "${BIFROST_HTTP_UNITS[@]}"
  bifrost-agent
  bifrost-account-sync
  "${BIFROST_CATEGORY_SOCKET_SERVICES[@]}"
)
declare -a RESTART_UNITS=()

# Interactive full-screen TUI: menu on top, last N lines of command output below (menu o = full log).
BIFROST_SSH_TUI=0
BIFROST_SSH_LAST_LOG=""
# Default tail height for Last output pane (override: export BIFROST_SSH_RESULT_LINES=N before running).
BIFROST_SSH_RESULT_LINES="${BIFROST_SSH_RESULT_LINES:-20}"
# When 1, Last output shows the entire session temp log; when 0, tail only (see BIFROST_SSH_LAST_OUTPUT_LINES after menu tl1).
BIFROST_SSH_LAST_OUTPUT_FULL=0
# Persistent deploy log — survives between sessions; overwritten on each deploy/pipeline run.
BIFROST_PERSIST_DEPLOY_LOG="${PROJECT_ROOT}/logs/.bifrost-deploy-last.log"
# MkDocs-only rsync log (menu tl6 / --deploy-mkdocs); separate from application deploy.
BIFROST_PERSIST_MKDOCS_LOG="${PROJECT_ROOT}/logs/.bifrost-mkdocs-deploy-last.log"
# TUI "Last output" tail count; after menu tl1 systemd install set high so log + summaries fit (cleared on other menu keys).
BIFROST_SSH_LAST_OUTPUT_LINES=""
# Interactive: systemd snapshot for header (menu s Status refreshes all bifrost-* on DEPLOY_HOST).
BIFROST_INTERACTIVE_STATUS_RAW=""
BIFROST_INTERACTIVE_STATUS_AT=""

# --- ANSI colors (stdout TTY only; avoids garbage in piped/CI logs) ---
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''
  C_BOLD=''
  C_DIM=''
  C_RED=''
  C_GREEN=''
  C_YELLOW=''
  C_BLUE=''
  C_MAGENTA=''
  C_CYAN=''
fi

_msg_info() { echo "${C_CYAN}${C_BOLD}[INFO]${C_RESET} $*"; }
_msg_warn() { echo "${C_YELLOW}${C_BOLD}[WARN]${C_RESET} $*" >&2; }
_msg_err() { echo "${C_RED}${C_BOLD}[ERROR]${C_RESET} $*" >&2; }
_msg_bug() { echo "${C_MAGENTA}${C_BOLD}[BUG]${C_RESET} $*" >&2; }

# Append a prominent colored result banner to a log file (or stdout). Args: $1=exit_code, $2=label, $3=log_file (optional; stdout if empty).
_emit_result_banner() {
  local _ec="$1" _label="$2" _log="${3:-}"
  local _ts
  _ts="$(date '+%H:%M:%S')"
  local _banner
  if [[ "${_ec}" -eq 0 ]]; then
    _banner=$(printf '\n%s\n%s  ✔  %s — %s (exit 0)  %s\n%s\n' \
      "${C_GREEN}${C_BOLD}════════════════════════════════════════════════════════${C_RESET}" \
      "${C_GREEN}${C_BOLD}" "${_label}" "SUCCESS" "${C_RESET}" \
      "${C_GREEN}${C_BOLD}════════════════════════════════════════════════════════${C_RESET}")
  else
    _banner=$(printf '\n%s\n%s  ✘  %s — %s (exit %d)  %s\n%s  %s  Check output above for errors (npm build? SSH? sudo?)  %s\n%s\n' \
      "${C_RED}${C_BOLD}════════════════════════════════════════════════════════${C_RESET}" \
      "${C_RED}${C_BOLD}" "${_label}" "FAILED" "${_ec}" "${C_RESET}" \
      "${C_YELLOW}" "${C_BOLD}" "${C_RESET}" \
      "${C_RED}${C_BOLD}════════════════════════════════════════════════════════${C_RESET}")
  fi
  if [[ -n "${_log}" ]]; then
    echo "${_banner}" >>"${_log}"
  else
    echo "${_banner}"
  fi
}

# Short label for TUI status column (keep in sync with BIFROST_STATUS_ROWS).
_bifrost_unit_display_label() {
  case "$1" in
    bifrost-server) printf '%s' 'Server' ;;
    bifrost-engine) printf '%s' 'Engine' ;;
    bifrost-massive) printf '%s' 'Massive' ;;
    bifrost-research) printf '%s' 'Research' ;;
    bifrost-docs) printf '%s' 'Docs' ;;
    bifrost-ops) printf '%s' 'Ops' ;;
    bifrost-trading) printf '%s' 'Trading' ;;
    bifrost-strategy) printf '%s' 'Strategy' ;;
    bifrost-portfolio) printf '%s' 'Portfolio' ;;
    bifrost-market) printf '%s' 'Market' ;;
    bifrost-agent) printf '%s' 'Agent' ;;
    bifrost-massive-ws) printf '%s' 'MassiveWS' ;;
    bifrost-ib-operator) printf '%s' 'IB-Op' ;;
    bifrost-ib-ingestor) printf '%s' 'IB-Ingest' ;;
    bifrost-ib-account-agent) printf '%s' 'IB-Acct' ;;
    bifrost-account-sync) printf '%s' 'AccSync' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Space-separated bifrost-*.service names for status refresh (banner order).
_bifrost_status_systemd_units_space() {
  printf '%s' "${BIFROST_STATUS_ROWS[*]}"
}

# Color one log line (remote command output) by keyword heuristics.
_colorize_line() {
  local line="$1"
  case "$line" in
    *ERROR*|*Error:*|*Failed*|*failed*|*Traceback*|*Exception*|*FATAL*|*Fatal*|*fatal:*)
      echo "${C_RED}${line}${C_RESET}"
      ;;
    *WARN*|*WARN:*|*Warning*|*WARNING*|*warning:*)
      echo "${C_YELLOW}${line}${C_RESET}"
      ;;
    *INFO*|*INFO:*|*Info:*)
      echo "${C_CYAN}${line}${C_RESET}"
      ;;
    *BUG*|*bug:*|*Bug:*|*Assertion*|*assert*)
      echo "${C_MAGENTA}${C_BOLD}${line}${C_RESET}"
      ;;
    *)
      echo "${line}"
      ;;
  esac
}

# Remote: emit one line per unit (stdout only). Args: $1 = space-separated unit names.
_bifrost_remote_emit_unit_status_script() {
  local _units_str="$1"
  cat <<EOF
set -euo pipefail
for u in ${_units_str}; do
  printf '%s: ' "\$u"
  act=\$(systemctl is-active "\$u" 2>/dev/null || true)
  sub=\$(systemctl show "\$u" -p SubState --value 2>/dev/null || true)
  if [[ "\$act" == "active" ]]; then
    echo "RUNNING (SubState=\${sub:-?})"
  elif [[ -n "\$act" ]]; then
    echo "NOT RUNNING (ActiveState=\$act\${sub:+, SubState=\$sub})"
  else
    echo "NOT RUNNING (could not query unit — check name or permissions)"
  fi
done
EOF
}

# Capture unit status lines to stdout (for grouping). Args: $1 = space-separated units.
_bifrost_remote_fetch_unit_status_raw() {
  local _units_str="$1"
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    {
      printf '%s\n' "${SUDO_PASSWORD}"
      _bifrost_remote_emit_unit_status_script "${_units_str}"
    } | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' bash -s"
  else
    _bifrost_remote_emit_unit_status_script "${_units_str}" | ssh_remote_stdin_pipe "${REMOTE}" bash -s
  fi
}

# Print one line per unit: "bifrost-…: RUNNING (SubState=…)" or NOT RUNNING (…)
# Args: $1 = space-separated systemd unit names. Uses SUDO_PASSWORD, ssh_remote, DEPLOY_*.
_bifrost_remote_print_unit_status() {
  local _units_str="$1"
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    {
      printf '%s\n' "${SUDO_PASSWORD}"
      _bifrost_remote_emit_unit_status_script "${_units_str}"
    } | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' bash -s"
  else
    _bifrost_remote_emit_unit_status_script "${_units_str}" | ssh_remote_stdin_pipe "${REMOTE}" bash -s
  fi
}

# Print captured status lines grouped by HTTP category (CLI --status). Args: $1 = raw multiline, rest = requested units.
_bifrost_cli_print_status_grouped() {
  local raw="$1"
  shift
  local -a want=("$@")
  local u w show
  _want_has() {
    local uu="$1"
    for w in "${want[@]}"; do
      [[ "${uu}" == "${w}" ]] && return 0
    done
    return 1
  }
  _emit_section() {
    local title="$1"
    shift
    local -a us=("$@")
    local show=0
    for u in "${us[@]}"; do
      if _want_has "${u}"; then
        show=1
        break
      fi
    done
    [[ "${show}" -eq 0 ]] && return 0
    echo ""
    echo "--- ${title} ---"
    for u in "${us[@]}"; do
      _want_has "${u}" || continue
      local line
      line=$(echo "${raw}" | grep -F "${u}:" | head -n 1 || true)
      if [[ -n "${line}" ]]; then
        line=$(echo "${line}" | sed -E "s/^.*(${u}:.*)/\\1/")
      fi
      if [[ -z "${line}" ]]; then
        echo "${u}: (no line — SSH or parse error)"
      else
        echo "${line}"
      fi
    done
  }
  _emit_section "Architecture" "${BIFROST_CATEGORY_ARCHITECTURE[@]}"
  _emit_section "Account (trading+portfolio)" "${BIFROST_CATEGORY_ACCOUNT[@]}"
  _emit_section "Research (market+research+strategy)" "${BIFROST_CATEGORY_RESEARCH[@]}"
  _emit_section "Feed (massive)" "${BIFROST_CATEGORY_FEED[@]}"
  _emit_section "Socket Services (ingest/IB edge)" "${BIFROST_CATEGORY_SOCKET_SERVICES[@]}"
  _emit_section "Daemon (trading engine + agent + account sync)" bifrost-engine bifrost-agent bifrost-account-sync
}

# Paint one unit row from BIFROST_INTERACTIVE_STATUS_RAW (unit name $1).
_bifrost_status_paint_one_row() {
  local u="$1"
  local label line rest
  label="$(_bifrost_unit_display_label "${u}")"
  line=$(echo "${BIFROST_INTERACTIVE_STATUS_RAW}" | grep -F "${u}:" | head -n 1 || true)
  if [[ -n "${line}" ]]; then
    line=$(echo "${line}" | sed -E "s/^.*(${u}:.*)/\\1/")
  fi
  if [[ -z "${line}" ]]; then
    printf '  %b %b%-9s%b  %b%s%b\n' "${C_YELLOW}" "${C_BOLD}" "${label}" "${C_RESET}" "${C_DIM}" "(no line — SSH or parse error)" "${C_RESET}"
    return 0
  fi
  rest="${line#"${u}: "}"
  if [[ "${rest}" == RUNNING* ]]; then
    printf '  %b●%b %b%-9s%b  %b%s%b\n' "${C_GREEN}${C_BOLD}" "${C_RESET}" "${C_BOLD}" "${label}" "${C_RESET}" "${C_GREEN}" "${rest}" "${C_RESET}"
  else
    printf '  %b●%b %b%-9s%b  %b%s%b\n' "${C_RED}${C_BOLD}" "${C_RESET}" "${C_BOLD}" "${label}" "${C_RESET}" "${C_RED}" "${rest}" "${C_RESET}"
  fi
}

# Paint units under the banner (grouped: Architecture / Account / Research / Feed / Socket Services / Daemon). Uses BIFROST_INTERACTIVE_STATUS_*.
_interactive_paint_remote_status_block() {
  if [[ -z "${BIFROST_INTERACTIVE_STATUS_RAW:-}" ]]; then
    echo "${C_DIM}  (Menu ${C_GREEN}s${C_DIM} / ${C_GREEN}3${C_DIM} Status loads systemd units from ${DEPLOY_HOST}; in ${C_BOLD}d${C_DIM} / ${C_BOLD}2${C_DIM} use ${C_BOLD}0${C_DIM} = restart all HTTP APIs.)${C_RESET}"
    return 0
  fi
  echo "${C_BLUE}${C_BOLD}  Units on ${DEPLOY_HOST}${C_RESET} ${C_DIM}· refreshed ${BIFROST_INTERACTIVE_STATUS_AT:-?}${C_RESET}"
  # sudo may prefix stderr merged into capture (2>&1)
  if ! echo "${BIFROST_INTERACTIVE_STATUS_RAW}" | grep -qE 'bifrost-(server|engine|massive|docs|ops|trading|strategy|portfolio|market|research|agent|massive-ws|ib-operator|ib-ingestor|ib-account-agent):'; then
    echo "${C_YELLOW}  $(echo "${BIFROST_INTERACTIVE_STATUS_RAW}" | head -n 1)${C_RESET}"
  fi
  echo "${C_MAGENTA}${C_BOLD}  Architecture${C_RESET}"
  for u in "${BIFROST_CATEGORY_ARCHITECTURE[@]}"; do _bifrost_status_paint_one_row "${u}"; done
  echo "${C_MAGENTA}${C_BOLD}  Account${C_RESET} ${C_DIM}(trading+portfolio)${C_RESET}"
  for u in "${BIFROST_CATEGORY_ACCOUNT[@]}"; do _bifrost_status_paint_one_row "${u}"; done
  echo "${C_MAGENTA}${C_BOLD}  Research${C_RESET} ${C_DIM}(market+research+strategy)${C_RESET}"
  for u in "${BIFROST_CATEGORY_RESEARCH[@]}"; do _bifrost_status_paint_one_row "${u}"; done
  echo "${C_MAGENTA}${C_BOLD}  Feed${C_RESET} ${C_DIM}(massive)${C_RESET}"
  for u in "${BIFROST_CATEGORY_FEED[@]}"; do _bifrost_status_paint_one_row "${u}"; done
  echo "${C_MAGENTA}${C_BOLD}  Socket Services${C_RESET} ${C_DIM}(ingest/IB edge)${C_RESET}"
  for u in "${BIFROST_CATEGORY_SOCKET_SERVICES[@]}"; do _bifrost_status_paint_one_row "${u}"; done
  echo "${C_MAGENTA}${C_BOLD}  Daemon${C_RESET} ${C_DIM}(trading engine + agent + account sync)${C_RESET}"
  _bifrost_status_paint_one_row bifrost-engine
  _bifrost_status_paint_one_row bifrost-agent
  _bifrost_status_paint_one_row bifrost-account-sync
}

_interactive_paint_main_menu() {
  echo "${C_BLUE}${C_BOLD}--- Main menu ---${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}r · 1)${C_RESET} ${C_BOLD}Reboot services${C_RESET} ${C_DIM}(systemctl: 0 / 1–3 / a–d / h3 / words — Engine: Dashboard)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}d · 2)${C_RESET} ${C_BOLD}Deploy${C_RESET} ${C_DIM}(${C_BOLD}0${C_DIM} = deploy+restart all 9 HTTP · ${C_BOLD}1–3${C_DIM}+optional ${C_BOLD}R${C_RESET}${C_DIM} · ${C_BOLD}a–d${C_DIM}+optional ${C_BOLD}R${C_RESET}${C_DIM} · ${C_BOLD}q${C_DIM} = cancel)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}s · 3)${C_RESET} ${C_BOLD}Status:${C_RESET} refresh ${C_DIM}(all bifrost units, summary above)${C_RESET}"
  echo "${C_DIM}  db — database${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}db1)${C_RESET} ${C_BOLD}Refresh schema${C_RESET} ${C_DIM}(Dev local / Prod remote)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}db2)${C_RESET} ${C_BOLD}Release locks${C_RESET} ${C_DIM}(dry-run then optional terminate)${C_RESET}"
  echo "${C_DIM}  tl — tooling${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}tl1)${C_RESET} ${C_BOLD}systemd install:${C_RESET} ${C_DIM}render nginx + rsync; register units; widens Last output; summary like ${C_BOLD}r${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}tl2)${C_RESET} Clear stored sudo password"
  echo "  ${C_GREEN}${C_BOLD}tl3)${C_RESET} Reconnect SSH master ${C_DIM}(password again)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}tl4)${C_RESET} ${C_BOLD}Local Mac:${C_RESET} Socket ingest + Celery ${C_DIM}(pgrep + pidfiles)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}tl5)${C_RESET} ${C_BOLD}Remote Prod:${C_RESET} systemd scan on ${DEPLOY_HOST} ${C_DIM}(bifrost-* + worker@*)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}tl6)${C_RESET} ${C_BOLD}MkDocs site:${C_RESET} build + rsync ${C_DIM}site/ → ${DEPLOY_PATH}/site/ ${C_RESET}${C_DIM}(no APIs or DB)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}o)${C_RESET} ${C_BOLD}Last output pane:${C_RESET} toggle ${C_DIM}full log vs last ${BIFROST_SSH_RESULT_LINES} lines${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}v)${C_RESET} ${C_BOLD}View last deploy log${C_RESET} ${C_DIM}(less; logs/.bifrost-deploy-last.log)${C_RESET}"
  echo "  ${C_YELLOW}${C_BOLD}q)${C_RESET} Quit"
}

# Bottom pane: either full session log or tail (default BIFROST_SSH_RESULT_LINES lines; widened by menu tl1 via BIFROST_SSH_LAST_OUTPUT_LINES). Menu o toggles full.
_interactive_paint_result_block() {
  local _tmp _n line _lim
  if [[ "${BIFROST_SSH_LAST_OUTPUT_FULL:-0}" == "1" ]]; then
    echo "${C_BLUE}${C_BOLD}── Last output (full) ──${C_RESET}"
    if [[ -f "${BIFROST_SSH_LAST_LOG}" ]] && [[ -s "${BIFROST_SSH_LAST_LOG}" ]]; then
      while IFS= read -r line || [[ -n "${line}" ]]; do
        _colorize_line "${line}"
      done <"${BIFROST_SSH_LAST_LOG}"
    else
      echo "${C_DIM}(empty)${C_RESET}"
    fi
    return 0
  fi
  _lim="${BIFROST_SSH_LAST_OUTPUT_LINES:-${BIFROST_SSH_RESULT_LINES}}"
  echo "${C_BLUE}${C_BOLD}── Last output (last ${_lim} lines) ──${C_RESET}"
  _tmp="$(mktemp -t bifrost_ssh_tui)"
  if [[ -f "${BIFROST_SSH_LAST_LOG}" ]] && [[ -s "${BIFROST_SSH_LAST_LOG}" ]]; then
    tail -n "${_lim}" "${BIFROST_SSH_LAST_LOG}" >"${_tmp}"
  else
    : >"${_tmp}"
  fi
  _n=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    _colorize_line "${line}"
    _n=$((_n + 1))
  done <"${_tmp}"
  rm -f "${_tmp}"
  while [[ ${_n} -lt ${_lim} ]]; do
    echo "${C_DIM}·${C_RESET}"
    _n=$((_n + 1))
  done
}

_interactive_paint_full() {
  clear 2>/dev/null || true
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  echo "${C_BLUE}${C_BOLD}  Bifrost SSH ${C_CYAN}(interactive)${C_RESET}  ${C_DIM}${DEPLOY_USER}@${DEPLOY_HOST}  ${DEPLOY_PATH}${C_RESET}"
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  _interactive_paint_remote_status_block
  echo ""
  _interactive_paint_main_menu
  _interactive_paint_result_block
}

usage() {
  cat <<'USAGE_EOF'
bifrost_ssh.sh — SSH to the prod Linux host: optional rsync --delete + remote build, optional systemctl on bifrost units.

Usage (from repo root):

  ./scripts/bifrost_ssh.sh
  ./scripts/bifrost_ssh.sh -i
  ./scripts/bifrost_ssh.sh --interactive
  ./scripts/bifrost_ssh.sh --password 'REMOTE_SUDO_SECRET' -i
      Interactive menu: open one SSH master (login once; kept until you quit), then run operations in a loop;
      sudo password you enter (or -p) is kept in memory for every menu action until quit or menu tl2 Clear.
      Main menu stays on top; last command output is shown in the bottom pane (20 lines by default; wider after tl1 systemd install; menu o toggles full log vs tail). Same flags as below.
      Keys: r or 1 Reboot services · d or 2 Deploy · s or 3 Status · db1/db2 schema & locks · tl1–tl6 tooling (nginx/ssh/local remote/MkDocs) · o/v/q.
      Menu s / 3 Status refreshes units grouped by category + Socket Services + Daemon (no bifrost-celery; use Ops UI). Menu tl1 appends repo unit file list + same summary as s. Deploy d / 2: 0 = deploy+restart all 9 HTTP APIs; 1–3 = single units (Engine: Dashboard); a–d = category; q or empty = cancel.
      Menu tl1 Install systemd: locally render deploy/nginx/bifrost-status.conf from merged prod YAML, rsync it to the server, then register deploy/systemd/*.service + *.target (sudo); install nginx site from that file + nginx -t + reload when nginx is present.
      Menu tl4 Local Mac: pgrep run_massive_ws / IB ingest / IB operator / run_celery + check logs/.ops-ingest-*.pid (this machine; not SSH).
      Menu tl6 MkDocs: mkdocs build + rsync site/ to DEPLOY_PATH only (no app/DB/systemctl; nginx serves /mkdocs/).
      Menu tl5 Remote Prod: systemctl scan on DEPLOY_HOST (bifrost-* units + socket ingest + bifrost-celery-worker@*); use --password if systemctl needs sudo.
      CLI: --local-mac-services | --remote-services-status | --deploy-mkdocs
      With --password / -p (or env DEPLOY_SUDO_PASSWORD), skip the sudo password prompt; value is
      kept in memory only for this process. Warning: --password may be visible in process listings.

  CLI (non-interactive):

  Required — pick services (one or more, or --all / --apis / --all-stack / one category flag) AND exactly one of start/stop/restart,
  OR use --status (with services), OR use --deploy-only alone:

    --server | -server          systemd unit bifrost-server
    --massive | -massive        systemd unit bifrost-massive (Feed / Massive API, run_server_massive.py)
    --docs | -docs              systemd unit bifrost-docs (merged OpenAPI docs, run_server_docs.py)
    --ops | -ops                systemd unit bifrost-ops
    --trading | -trading        systemd unit bifrost-trading (run_server_trading.py)
    --strategy | -strategy      systemd unit bifrost-strategy (run_server_strategy.py)
    --portfolio | -portfolio    systemd unit bifrost-portfolio (run_server_portfolio.py)
    --market | -market          systemd unit bifrost-market (run_server_market.py)
    --bifrost-research          systemd unit bifrost-research (run_server_research.py, research_port)
    --agent | -agent            systemd unit bifrost-agent
                                bifrost-engine is not a flag here — start/stop/restart Engine via Ops UI (same as Socket Services).
    --all | -all                bifrost-server only (Engine is not controlled by this script — use Ops UI)
    --apis | -apis              all nine HTTP API units (architecture+account+research+feed; see category flags)
    --all-stack | -all-stack    full stack: nine APIs + bifrost-agent + four Socket Services units (14 units; no Celery, no Engine)

    --architecture              HTTP category: bifrost-server, bifrost-ops, bifrost-docs
    --account                   HTTP category: bifrost-trading, bifrost-portfolio
    --research                  HTTP category: bifrost-market, bifrost-research, bifrost-strategy (not --bifrost-research alone)
    --feed                      HTTP category: bifrost-massive only

    --stop | -stop              sudo systemctl stop …
    --start | -start            sudo systemctl start …
    --restart | -restart        sudo systemctl restart …
    --status | -status          query ActiveState via systemctl is-active (+ SubState); combine with
                                per-unit flags, --all, --apis, --all-stack, or one category flag (no start/stop/restart required).
                                May be combined with --deploy / --restart to print status after those steps.

  Optional:

    --deploy | -deploy          rsync --delete + remote venv pip + npm build, then run systemctl if actions above are set
    --deploy-only               only rsync --delete + remote build (no systemctl); use for first push or code-only sync

    --migrate                   with --deploy or --deploy-only: run db_refresh_schema.py --prod on remote
    --sync-prod-config          with deploy: also rsync config/config.prod.yaml (overwrites remote)

    --db-refresh                Remote ${DEPLOY_PATH}: python scripts/db_refresh_schema.py --prod (no rsync). Interactive menu db1 Prod.
    --db-refresh-dev            This machine (repo root): python scripts/db_refresh_schema.py --dev (local .venv if present).
    --db-release-locks          Remote: db_release_dblock.py --prod --dry-run.
    --db-release-locks-dev      Local: db_release_dblock.py --dev --dry-run.
    --db-release-locks-terminate  Remote: db_release_dblock.py --prod --yes.
    --db-release-locks-terminate-dev  Local: db_release_dblock.py --dev --yes.

    --show-last-deploy            print the full output of the last deploy/pipeline run (saved to
                                  logs/.bifrost-deploy-last.log) using less -R (or cat if less is absent).
                                  Does not SSH or deploy. Use after a failed deploy to see the full log.

    --deploy-mkdocs               MkDocs only: run mkdocs build -f mkdocs.prod.yml locally, then rsync site/
                                  to DEPLOY_PATH/site/ on DEPLOY_HOST. Does not run app pip/npm, DB tools,
                                  or systemctl. Separate from --deploy / --deploy-only. Requires mkdocs
                                  (uv sync --extra docs). Nginx must serve /mkdocs/ (see deploy/nginx templates).

    --local-mac-services          this machine only: pgrep + pidfiles for run_massive_ws / run_ib_ingestor /
                                  run_ib_operator / run_celery (see Examples).

    --remote-services-status      SSH to DEPLOY_HOST: systemctl is-active for bifrost HTTP stack + engine + celery + agent +
                                  Socket Services (massive-ws, ib-operator, ib-ingestor, ib-account-agent); list bifrost-celery-worker@*.
                                  Optional --password if remote systemctl requires sudo.

    --install-systemd-units       Same as interactive menu tl1: on this machine run scripts/render_nginx_status_conf.py with merged
                                  config/config.prod.yaml, then rsync deploy/nginx/bifrost-status.conf to the server. Remote: register
                                  deploy/systemd/*.service and *.target, daemon-reload, copy nginx site, nginx -t, reload when nginx
                                  exists. One-shot; no other flags. Sync unit files first if needed (e.g. --deploy-only).

    --password VALUE | -p VALUE | --password=VALUE
                                remote sudo password for sudo -S (interactive: skip password prompt;
                                CLI: non-interactive sudo without NOPASSWD). Same as env DEPLOY_SUDO_PASSWORD.
                                If sshpass(1) is installed, the same value is also used for SSH/rsync
                                (non-interactive); otherwise only sudo is automated — use SSH keys or install sshpass.

  Environment:

    DEPLOY_HOST   (default 192.168.10.70)
    DEPLOY_USER   (default vision)
    DEPLOY_PATH   (default /home/vision/bifrost-trader-engine)
    DEPLOY_SUDO_PASSWORD  optional; same effect as --password (skips interactive sudo prompt)
    BIFROST_SSH_RESULT_LINES  optional; interactive TUI only — default tail height for Last output pane (default 20)

Examples:

  ./scripts/bifrost_ssh.sh --deploy-only
  ./scripts/bifrost_ssh.sh -server --stop
  ./scripts/bifrost_ssh.sh --all --restart -deploy
  ./scripts/bifrost_ssh.sh --all-stack --restart -deploy
  ./scripts/bifrost_ssh.sh --apis --restart -deploy
  ./scripts/bifrost_ssh.sh --research --restart -deploy
  ./scripts/bifrost_ssh.sh --feed --status
  ./scripts/bifrost_ssh.sh -massive -restart -deploy
  ./scripts/bifrost_ssh.sh -ops -restart -deploy
  ./scripts/bifrost_ssh.sh -agent -restart -deploy
  ./scripts/bifrost_ssh.sh --all --status
  ./scripts/bifrost_ssh.sh -server --status

  ./scripts/bifrost_ssh.sh --db-refresh
  ./scripts/bifrost_ssh.sh --db-refresh-dev
  ./scripts/bifrost_ssh.sh --db-release-locks
  ./scripts/bifrost_ssh.sh --db-release-locks-dev
  ./scripts/bifrost_ssh.sh --db-release-locks-terminate
  ./scripts/bifrost_ssh.sh --db-release-locks-terminate-dev

  ./scripts/bifrost_ssh.sh --local-mac-services
      On this Mac only: from repo root, pgrep Socket ingest + Celery (same scripts as
      Ops SubprocessLocalExecutor on macOS). Prints PID, command line, repo-path match, and
      logs/.ops-ingest-*.pid staleness — useful when processes run but Settings UI looks empty.

  ./scripts/bifrost_ssh.sh --remote-services-status
  ./scripts/bifrost_ssh.sh -p 'SUDO' --remote-services-status
      On DEPLOY_HOST (Linux): systemctl for full bifrost unit set + socket ingest + Celery worker instances.

  ./scripts/bifrost_ssh.sh --install-systemd-units
  ./scripts/bifrost_ssh.sh -p 'SUDO' --install-systemd-units

  ./scripts/bifrost_ssh.sh --show-last-deploy
      View the full output of the last deploy run (no SSH required).
      Log is saved at logs/.bifrost-deploy-last.log every time a pipeline runs.

  ./scripts/bifrost_ssh.sh --deploy-mkdocs
      Publish static handbook only: mkdocs build + rsync site/ → remote (log: logs/.bifrost-mkdocs-deploy-last.log).

systemctl over SSH uses ssh -t when stdin is a TTY so sudo can prompt; non-interactive needs NOPASSWD for systemctl.
With --password, --status uses sudo -S like start/stop/restart; without it, status runs as the SSH user (often sufficient for is-active).
USAGE_EOF
}

usage_error() {
  echo "" >&2
  _msg_err "$*"
  echo "" >&2
  usage >&2
  exit 1
}

_restart_add_unit() {
  local u="$1"
  local x
  if [[ -n "${RESTART_CATEGORY}" ]]; then
    usage_error "per-unit flags cannot be combined with --architecture/--account/--research/--feed."
  fi
  if [[ ${#RESTART_UNITS[@]} -eq 0 ]]; then
    RESTART_UNITS+=("$u")
    return 0
  fi
  for x in "${RESTART_UNITS[@]}"; do
    [[ "$x" == "$u" ]] && return 0
  done
  RESTART_UNITS+=("$u")
}

# CLI: select one HTTP category (mutually exclusive with other category flags).
_pick_category_flag() {
  local c="$1"
  if [[ -n "${RESTART_CATEGORY}" ]]; then
    usage_error "use only one of --architecture, --account, --research, --feed."
  fi
  if [[ "${RESTART_ALL}" == "1" || "${RESTART_ALL_STACK}" == "1" || "${RESTART_ALL_APIS}" == "1" ]]; then
    usage_error "cannot combine category flags with --all, --apis, or --all-stack."
  fi
  if [[ ${#RESTART_UNITS[@]} -gt 0 ]]; then
    usage_error "category flags cannot be combined with per-unit flags (--server, …)."
  fi
  RESTART_CATEGORY="${c}"
}

_set_action() {
  local a="$1"
  if [[ -n "${ACTION}" && "${ACTION}" != "${a}" ]]; then
    usage_error "specify only one of --stop, --start, or --restart (got both ${ACTION} and ${a})."
  fi
  ACTION="${a}"
}

# --- SSH / rsync helpers (ControlMaster when SSH_CONTROL_PATH is set) ---

# True when we can feed SSH the same secret as sudo (non-interactive): requires sshpass(1).
_use_sshpass_for_ssh() {
  [[ -n "${SUDO_PASSWORD}" ]] && command -v sshpass >/dev/null 2>&1
}

# Plain ssh (no multiplex socket). With --password/-p + sshpass, uses SSHPASS so SSH/rsync
# do not re-prompt; without sshpass, only sudo -S is automated (SSH still prompts unless keys).
_ssh_plain() {
  if _use_sshpass_for_ssh; then
    SSHPASS="${SUDO_PASSWORD}" sshpass -e ssh "$@"
  else
    ssh "$@"
  fi
}

ssh_remote() {
  if [[ -n "${SSH_CONTROL_PATH}" ]]; then
    ssh -S "${SSH_CONTROL_PATH}" "$@"
  else
    _ssh_plain "$@"
  fi
}

# Like ssh_remote but allocate a PTY on the remote (-tt even when stdin is not a tty).
# Needed so remote Python (e.g. db_refresh_schema.py) sees stderr as a TTY and keeps ANSI colors
# when local stdout is piped to tee or captured.
ssh_remote_tty() {
  if [[ -n "${SSH_CONTROL_PATH}" ]]; then
    ssh -tt -S "${SSH_CONTROL_PATH}" "$@"
  else
    if _use_sshpass_for_ssh; then
      SSHPASS="${SUDO_PASSWORD}" sshpass -e ssh -tt "$@"
    else
      ssh -tt "$@"
    fi
  fi
}

# ssh -T: do not allocate a PTY. Required when piping the sudo password to `sudo -S` while stdout is
# redirected (e.g. interactive TUI + tee); otherwise the remote may fall back to a tty sudo prompt.
ssh_remote_stdin_pipe() {
  if [[ -n "${SSH_CONTROL_PATH}" ]]; then
    ssh -T -S "${SSH_CONTROL_PATH}" "$@"
  else
    if _use_sshpass_for_ssh; then
      SSHPASS="${SUDO_PASSWORD}" sshpass -e ssh -T "$@"
    else
      ssh -T "$@"
    fi
  fi
}

_ssh_control_cleanup() {
  if [[ -n "${SSH_CONTROL_PATH}" ]] && [[ -S "${SSH_CONTROL_PATH}" ]]; then
    ssh -S "${SSH_CONTROL_PATH}" -O exit "${DEPLOY_USER}@${DEPLOY_HOST}" 2>/dev/null || true
    rm -f "${SSH_CONTROL_PATH}" 2>/dev/null || true
  fi
}

_ssh_control_start() {
  local remote="${DEPLOY_USER}@${DEPLOY_HOST}"
  local sock="${HOME}/.ssh/bifrost_ssh_${DEPLOY_USER}_$(echo "${DEPLOY_HOST}" | tr '.:' '__').sock"
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh" 2>/dev/null || true
  SSH_CONTROL_PATH="${sock}"
  if [[ -S "${SSH_CONTROL_PATH}" ]]; then
    if ssh -S "${SSH_CONTROL_PATH}" -O check "${remote}" 2>/dev/null; then
      _msg_info "Reusing existing SSH control socket: ${SSH_CONTROL_PATH}"
      return 0
    fi
    rm -f "${SSH_CONTROL_PATH}"
  fi
  _msg_info "Opening SSH master session to ${remote} (password not saved to disk)."
  echo "${C_DIM}Tip: use SSH keys to skip password prompts.${C_RESET}"
  if _use_sshpass_for_ssh; then
    _msg_info "Using sshpass for SSH login (same secret as --password / -p / DEPLOY_SUDO_PASSWORD)."
  fi
  # -M master, -f background after auth, -N no remote command — ControlPersist=yes keeps the master for
  # the whole interactive session (idle menus included). EXIT trap closes it; avoid 300s drop → re-prompt SSH.
  if ! _ssh_plain -M -S "${SSH_CONTROL_PATH}" -o ControlPersist=yes -o ConnectTimeout=15 -f -N "${remote}"; then
    SSH_CONTROL_PATH=""
    _msg_warn "Failed to start SSH master. Continuing without multiplexing (each command may ask for password)."
    return 1
  fi
  _msg_info "SSH master ready (socket: ${SSH_CONTROL_PATH})."
}

_show_result() {
  local title="$1"
  local tmp
  tmp="$(mktemp -t bifrost_ssh_out)"
  {
    echo "${C_BLUE}${C_BOLD}======== ${title} ========${C_RESET}"
    while IFS= read -r line || [[ -n "${line}" ]]; do
      _colorize_line "${line}"
    done
    echo "${C_DIM}======== end (colors: ${C_CYAN}INFO${C_DIM} / ${C_YELLOW}WARN${C_DIM} / ${C_RED}error${C_DIM} / ${C_MAGENTA}BUG${C_DIM}) ========${C_RESET}"
  } >"${tmp}"
  if command -v less >/dev/null 2>&1; then
    less -R -F "${tmp}" || true
  else
    cat "${tmp}"
  fi
  rm -f "${tmp}"
}

_reset_run_state() {
  DO_DEPLOY=0
  DO_DEPLOY_ONLY=0
  DO_MIGRATE=0
  SYNC_PROD_CONFIG="${DEPLOY_SYNC_PROD_CONFIG:-0}"
  RESTART_ALL=0
  RESTART_ALL_STACK=0
  RESTART_ALL_APIS=0
  RESTART_CATEGORY=""
  ACTION=""
  DO_STATUS=0
  RESTART_UNITS=()
}

# Re-apply sudo password from interactive session backup (defensive; keeps sudo -S working for every menu run).
_bifrost_restore_session_sudo() {
  if [[ -n "${BIFROST_SESSION_SUDO_PASSWORD:-}" ]]; then
    SUDO_PASSWORD="${BIFROST_SESSION_SUDO_PASSWORD//$'\r'/}"
  fi
}

# After rsync: daemon-reload (clears "unit file changed on disk" warnings) and register any
# *.service under deploy/systemd/ that systemd does not load yet (e.g. bifrost-ops.service, bifrost-agent.service).
_bifrost_remote_post_deploy_systemd() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local _qpath _body _q _ec
  _qpath=$(printf '%q' "${DEPLOY_PATH}")
  _bifrost_restore_session_sudo
  _body=$(cat <<'POST_DEPLOY_SYSTEMD_EOF'
set -euo pipefail
shopt -s nullglob
SRC="${DEPLOY_PATH}/deploy/systemd"
if [[ ! -d "${SRC}" ]]; then
  echo "WARN: ${SRC} missing; skip systemd sync."
  exit 0
fi
systemctl daemon-reload
for f in "${SRC}"/*.service "${SRC}"/*.target; do
  [[ -f "$f" ]] || continue
  bn=$(basename "$f")
  dest="/etc/systemd/system/${bn}"
  _load=$(systemctl show "${bn}" -p LoadState --value 2>/dev/null || true)
  if [[ "${_load}" == "not-found" ]] || [[ -z "${_load}" ]]; then
    echo "Registering unit ${bn} (not loaded yet) ..."
    if systemctl enable "$f" 2>/dev/null; then
      echo "  systemctl enable $f"
    elif cp -f "$f" "$dest" 2>/dev/null; then
      echo "  cp -> ${dest}"
    else
      _rsrc=$(readlink -f "$f" 2>/dev/null || true)
      _rdst=$(readlink -f "$dest" 2>/dev/null || true)
      if [[ -n "${_rsrc}" ]] && [[ "${_rsrc}" == "${_rdst}" ]]; then
        echo "  ${bn} already installed (symlink or same path as repo); OK"
      elif rm -f "$dest" && cp -f "$f" "$dest"; then
        echo "  cp -> ${dest} (replaced previous link/copy)"
      else
        echo "ERROR: could not register ${f}" >&2
        exit 1
      fi
    fi
  fi
done
systemctl daemon-reload
echo "systemd: daemon-reload done; units under ${SRC} are known to systemd."
POST_DEPLOY_SYSTEMD_EOF
)
  _q=$(printf '%q' "${_body}")
  _ec=0
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    printf '%s\n' "${SUDO_PASSWORD}" | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' env DEPLOY_PATH=${_qpath} bash -c ${_q}"
    _ec=$?
  elif [[ -r /dev/tty ]]; then
    ssh_remote -tt "${REMOTE}" "sudo env DEPLOY_PATH=${_qpath} bash -c ${_q}" </dev/tty
    _ec=$?
  else
    set +e
    ssh_remote "${REMOTE}" "sudo -n env DEPLOY_PATH=${_qpath} bash -c ${_q}"
    _ec=$?
    set -e
    if [[ ${_ec} -ne 0 ]]; then
      _msg_err "post-deploy systemd sync failed (sudo). Run: ./scripts/bifrost_ssh.sh --install-systemd-units"
    fi
  fi
  return "${_ec}"
}

# Save deploy output to a persistent log file (overwrite). Args: $1=label, $2=exit_code, $3=source_log_file.
# Strips ANSI escape codes so the saved file is grep/less friendly in non-color terminals too.
_bifrost_save_persist_deploy_log() {
  local _label="$1" _ec="$2" _src="$3"
  mkdir -p "$(dirname "${BIFROST_PERSIST_DEPLOY_LOG}")" 2>/dev/null || true
  {
    printf '=== Deploy log: %s | %s | exit %d ===\n' \
      "${_label}" "$(date '+%Y-%m-%d %H:%M:%S')" "${_ec}"
    if [[ -f "${_src}" ]]; then
      # Strip ANSI color codes so the log is clean when viewed outside a color terminal.
      sed 's/\x1b\[[0-9;]*[mKHJfABCDGsu]//g; s/\x1b(B//g' "${_src}"
    fi
    printf '=== end (exit %d) ===\n' "${_ec}"
  } > "${BIFROST_PERSIST_DEPLOY_LOG}" 2>/dev/null || true
}

# Same as _bifrost_save_persist_deploy_log but for MkDocs static publish.
_bifrost_save_mkdocs_deploy_log() {
  local _label="$1" _ec="$2" _src="$3"
  mkdir -p "$(dirname "${BIFROST_PERSIST_MKDOCS_LOG}")" 2>/dev/null || true
  {
    printf '=== MkDocs deploy log: %s | %s | exit %d ===\n' \
      "${_label}" "$(date '+%Y-%m-%d %H:%M:%S')" "${_ec}"
    if [[ -f "${_src}" ]]; then
      sed 's/\x1b\[[0-9;]*[mKHJfABCDGsu]//g; s/\x1b(B//g' "${_src}"
    fi
    printf '=== end (exit %d) ===\n' "${_ec}"
  } > "${BIFROST_PERSIST_MKDOCS_LOG}" 2>/dev/null || true
}

# Build MkDocs static site/ (mkdocs.prod.yml) and rsync to DEPLOY_PATH/site/. No venv pip of app deps, no npm, no DB, no systemctl.
_bifrost_run_mkdocs_deploy_core() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  _bifrost_restore_session_sudo
  cd "${PROJECT_ROOT}" || {
    echo "ERROR: cannot cd to ${PROJECT_ROOT}" >&2
    return 1
  }
  local py="${PROJECT_ROOT}/.venv/bin/python"
  [[ -x "${py}" ]] || py="python3"
  if ! command -v "${py}" >/dev/null 2>&1; then
    echo "ERROR: no Python interpreter (${py})." >&2
    return 1
  fi
  if ! "${py}" -c "import mkdocs" 2>/dev/null; then
    echo "ERROR: mkdocs not installed. On this machine: uv sync --extra docs  (or pip install -e '.[docs]')." >&2
    return 1
  fi
  if [[ ! -f "${PROJECT_ROOT}/mkdocs.prod.yml" ]]; then
    echo "ERROR: ${PROJECT_ROOT}/mkdocs.prod.yml missing." >&2
    return 1
  fi
  _msg_info "Running: ${py} -m mkdocs build -f mkdocs.prod.yml"
  if ! "${py}" -m mkdocs build -f mkdocs.prod.yml; then
    return 1
  fi
  if [[ ! -f "${PROJECT_ROOT}/site/index.html" ]]; then
    echo "ERROR: mkdocs build did not produce site/index.html" >&2
    return 1
  fi
  _msg_info "rsync site/ -> ${REMOTE}:${DEPLOY_PATH}/site/ (documentation only; nginx /mkdocs/)"
  ssh_remote "${REMOTE}" "mkdir -p $(printf '%q' "${DEPLOY_PATH}/site")"
  if [[ -n "${SSH_CONTROL_PATH}" ]]; then
    rsync -avz --delete -e "ssh -S ${SSH_CONTROL_PATH}" "${PROJECT_ROOT}/site/" "${REMOTE}:${DEPLOY_PATH}/site/"
  elif _use_sshpass_for_ssh; then
    SSHPASS="${SUDO_PASSWORD}" rsync -avz --delete -e "sshpass -e ssh" "${PROJECT_ROOT}/site/" "${REMOTE}:${DEPLOY_PATH}/site/"
  else
    rsync -avz --delete -e ssh "${PROJECT_ROOT}/site/" "${REMOTE}:${DEPLOY_PATH}/site/"
  fi
  _msg_info "Done. UI header Docs → /mkdocs/ requires nginx location (see deploy/nginx/bifrost-status.conf.template); reload nginx after first install."
}

_cli_deploy_mkdocs() {
  local _log _ec _pipeline_label
  _log="$(mktemp -t bifrost_mkdocs_deploy)"
  _pipeline_label="MkDocs deploy"
  set +e
  _bifrost_run_mkdocs_deploy_core >"${_log}" 2>&1
  _ec=$?
  set -e
  _bifrost_save_mkdocs_deploy_log "${_pipeline_label}" "${_ec}" "${_log}"
  _show_result "MkDocs deploy (exit ${_ec})" < "${_log}"
  _emit_result_banner "${_ec}" "${_pipeline_label}"
  if [[ "${_ec}" -ne 0 ]]; then
    _msg_info "Full log saved to: ${BIFROST_PERSIST_MKDOCS_LOG}"
  fi
  rm -f "${_log}"
  return "${_ec}"
}

_interactive_deploy_mkdocs() {
  local _ec
  _msg_info "MkDocs: build + rsync only (no application deploy, DB, or systemctl)."
  echo ""
  set +e
  _bifrost_run_mkdocs_deploy_core 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
  _ec=${PIPESTATUS[0]}
  set -e
  {
    echo ""
    echo "--- exit code: ${_ec} ---"
  } | tee -a "${BIFROST_SSH_LAST_LOG}"
  _bifrost_save_mkdocs_deploy_log "MkDocs deploy (interactive)" "${_ec}" "${BIFROST_SSH_LAST_LOG}"
  if [[ "${_ec}" -eq 0 ]]; then
    _msg_info "${C_GREEN}${C_BOLD}MkDocs deploy — SUCCESS${C_RESET} Log: ${BIFROST_PERSIST_MKDOCS_LOG}"
  else
    _msg_err "MkDocs deploy — ${C_RED}${C_BOLD}FAILED (exit ${_ec})${C_RESET}. See Last output or ${BIFROST_PERSIST_MKDOCS_LOG}"
  fi
  _msg_info "Redrawing menu…"
  return 0
}

_run_pipeline() {
  _bifrost_restore_session_sudo
  # Uses globals: DO_DEPLOY, DO_DEPLOY_ONLY, DO_MIGRATE, SYNC_PROD_CONFIG, ACTION, RESTART_UNITS, RESTART_ALL*, BIFROST_*_UNITS
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local REMOTE_URL="${REMOTE}:${DEPLOY_PATH}/"
  local DO_SYNC=0
  local DO_SYSTEMCTL=0

  if [[ "${RESTART_ALL_APIS}" == "1" ]]; then
    RESTART_UNITS=("${BIFROST_HTTP_UNITS[@]}")
  elif [[ "${RESTART_ALL_STACK}" == "1" ]]; then
    RESTART_UNITS=("${BIFROST_FULL_STACK_UNITS[@]}")
  elif [[ "${RESTART_ALL}" == "1" ]]; then
    RESTART_UNITS=(bifrost-server)
  elif [[ -n "${RESTART_CATEGORY}" ]]; then
    case "${RESTART_CATEGORY}" in
      architecture) RESTART_UNITS=("${BIFROST_CATEGORY_ARCHITECTURE[@]}") ;;
      account) RESTART_UNITS=("${BIFROST_CATEGORY_ACCOUNT[@]}") ;;
      research) RESTART_UNITS=("${BIFROST_CATEGORY_RESEARCH[@]}") ;;
      feed) RESTART_UNITS=("${BIFROST_CATEGORY_FEED[@]}") ;;
      *) _msg_err "unknown RESTART_CATEGORY=${RESTART_CATEGORY}"; return 1 ;;
    esac
  fi

  if [[ "${DO_DEPLOY_ONLY}" == "1" ]]; then
    DO_SYSTEMCTL=0
  elif [[ -n "${ACTION}" ]]; then
    DO_SYSTEMCTL=1
  else
    DO_SYSTEMCTL=0
  fi

  if [[ "${DO_DEPLOY}" == "1" || "${DO_DEPLOY_ONLY}" == "1" ]]; then
    DO_SYNC=1
  fi

  # Nested so we can run the same body with tee (TUI) or capture-only (non-TUI).
  _run_pipeline_inner() {
    set -e
    _bifrost_restore_session_sudo
    if [[ "${DO_SYNC}" == "1" ]]; then
      _msg_info "Deploying ${PROJECT_ROOT} -> ${REMOTE_URL} (rsync --delete: remove on remote what is not in this tree, subject to excludes below)."
      if [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
        _msg_info "Including config/config.prod.yaml (will overwrite remote file if present)."
      else
        _msg_info "Excluding config/config.prod.yaml (pass --sync-prod-config or DEPLOY_SYNC_PROD_CONFIG=1 to push it)."
      fi

      RSYNC_EXCLUDES=(
        --exclude='.git/'
        --exclude='.venv/'
        --exclude='venv/'
        --exclude='env/'
        --exclude='__pycache__/'
        --exclude='*.py[cod]'
        --exclude='.eggs/'
        --exclude='*.egg-info/'
        --exclude='frontend/node_modules/'
        --exclude='frontend/dist/'
        --exclude='.DS_Store'
        --exclude='site/'
      )
      if [[ "${SYNC_PROD_CONFIG}" != "1" ]]; then
        RSYNC_EXCLUDES+=(--exclude='config/config.prod.yaml')
      fi

      if [[ -n "${SSH_CONTROL_PATH}" ]]; then
        rsync -avz --delete \
          -e "ssh -S ${SSH_CONTROL_PATH}" \
          "${RSYNC_EXCLUDES[@]}" \
          "${PROJECT_ROOT}/" \
          "${REMOTE_URL}"
      elif _use_sshpass_for_ssh; then
        SSHPASS="${SUDO_PASSWORD}" rsync -avz --delete \
          -e "sshpass -e ssh" \
          "${RSYNC_EXCLUDES[@]}" \
          "${PROJECT_ROOT}/" \
          "${REMOTE_URL}"
      else
        rsync -avz --delete \
          -e ssh \
          "${RSYNC_EXCLUDES[@]}" \
          "${PROJECT_ROOT}/" \
          "${REMOTE_URL}"
      fi

      ssh_remote "${REMOTE}" \
        DEPLOY_PATH="${DEPLOY_PATH}" \
        DO_MIGRATE="${DO_MIGRATE}" \
        bash -s <<'REMOTE_EOF'
set -euo pipefail
cd "$DEPLOY_PATH"
if [[ ! -f .venv/bin/activate ]]; then
  rm -rf .venv
  if ! python3 -m venv .venv; then
    echo "" >&2
    echo "venv creation failed (often: ensurepip not installed)." >&2
    echo "On Debian/Ubuntu run: sudo apt install python3-venv" >&2
    echo "Or match your Python version: sudo apt install python3.12-venv" >&2
    exit 1
  fi
fi
# shellcheck source=/dev/null
source .venv/bin/activate
python -m pip install -U pip
python -m pip install -r requirements.txt
cd frontend
npm ci
npm run build
cd ..
if [[ "${DO_MIGRATE}" == "1" ]]; then
  echo "Running db_refresh_schema.py --prod ..."
  export FORCE_COLOR=1
  python scripts/db_refresh_schema.py --prod
fi
echo "[OK] Remote install/build finished."
REMOTE_EOF
      _bifrost_remote_post_deploy_systemd
    else
      _msg_info "Skipping rsync / remote build."
    fi

    if [[ "${DO_SYSTEMCTL}" == "1" ]]; then
      _units_str="${RESTART_UNITS[*]}"
      _msg_info "Running: sudo systemctl ${ACTION} ${_units_str}"
      if [[ -n "${SUDO_PASSWORD}" ]]; then
        printf '%s\n' "${SUDO_PASSWORD}" | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' systemctl ${ACTION} ${_units_str}"
      else
        # Interactive sudo: must read from the real terminal. A plain `cmd | tee` runs cmd in a subshell
        # where `ssh -tt` + sudo may not get a usable TTY — use /dev/tty when available.
        if [[ -r /dev/tty ]]; then
          ssh_remote -tt "${REMOTE}" "sudo systemctl ${ACTION} ${_units_str}" </dev/tty
        elif [[ -t 0 ]]; then
          ssh_remote -tt "${REMOTE}" "sudo systemctl ${ACTION} ${_units_str}"
        else
          ssh_remote "${REMOTE}" "sudo -n systemctl ${ACTION} ${_units_str}" 2>/dev/null || \
            echo "WARN: sudo -n failed; use interactive TTY or set NOPASSWD, or enter sudo password when prompted in interactive mode."
        fi
      fi
    elif [[ "${DO_DEPLOY_ONLY}" == "1" ]]; then
      echo "Deploy-only finished (no systemctl)."
    fi

    if [[ "${DO_STATUS}" == "1" ]]; then
      _units_str="${RESTART_UNITS[*]}"
      echo "Remote: systemctl status check (is-active + SubState) for: ${_units_str}"
      _st_raw="$(_bifrost_remote_fetch_unit_status_raw "${_units_str}" 2>&1)"
      _bifrost_cli_print_status_grouped "${_st_raw}" "${RESTART_UNITS[@]}"
    fi
  }

  local _log _ec _pipeline_label
  _log="$(mktemp -t bifrost_ssh_run)"
  _pipeline_label="Deploy"
  [[ "${DO_SYNC}" == "1" ]] && _pipeline_label="Deploy + Build"
  [[ "${DO_SYSTEMCTL}" == "1" ]] && _pipeline_label="Deploy + Restart"
  [[ "${DO_SYNC}" != "1" && "${DO_SYSTEMCTL}" == "1" ]] && _pipeline_label="systemctl ${ACTION}"
  [[ "${DO_DEPLOY_ONLY}" == "1" ]] && _pipeline_label="Deploy-only"
  set +e
  if [[ "${BIFROST_SSH_TUI:-0}" == "1" ]] && [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]]; then
    _msg_info "Running on remote — output streams below (SSH/sudo may take a while; sudo may prompt for password)."
    echo ""
    # Use process substitution so _run_pipeline_inner runs in the current shell, not a pipeline subshell.
    # Otherwise ssh -tt + sudo interactive password can misbehave or re-prompt.
    _run_pipeline_inner > >(tee "${BIFROST_SSH_LAST_LOG}") 2>&1
    _ec=$?
    _emit_result_banner "${_ec}" "${_pipeline_label}" "${BIFROST_SSH_LAST_LOG}"
    _bifrost_save_persist_deploy_log "${_pipeline_label}" "${_ec}" "${BIFROST_SSH_LAST_LOG}"
    if [[ "${_ec}" -eq 0 ]]; then
      _msg_info "${C_GREEN}${C_BOLD}${_pipeline_label} — SUCCESS${C_RESET} Redrawing menu…"
    else
      _msg_err "${_pipeline_label} — ${C_RED}${C_BOLD}FAILED (exit ${_ec})${C_RESET}. Check Last output below (or press v to view full log)."
    fi
  else
    _run_pipeline_inner >"${_log}" 2>&1
    _ec=$?
    _bifrost_save_persist_deploy_log "${_pipeline_label}" "${_ec}" "${_log}"
    _show_result "Command output (exit ${_ec})" < "${_log}"
    _emit_result_banner "${_ec}" "${_pipeline_label}"
    if [[ "${_ec}" -ne 0 ]]; then
      _msg_info "Full log saved to: ${BIFROST_PERSIST_DEPLOY_LOG}"
      _msg_info "View with: ./scripts/bifrost_ssh.sh --show-last-deploy"
    fi
  fi
  set -e
  rm -f "${_log}"
  return "${_ec}"
}

# Interactive: rsync --delete + remote build; optional systemctl restart.
# Keys align with main menu r/1 (Reboot services) unit legend: 0=all HTTP restart, 1–3=single units (no Engine — use Dashboard), a–d=categories; R suffix = restart after deploy.
_interactive_quick_deploy() {
  local _raw _norm _digit _ltr _want_r _qd_ec
  echo ""
  echo "${C_BLUE}${C_BOLD}--- Deploy ---${C_RESET}"
  _msg_info "Remote: rsync --delete + venv pip + npm build (includes React SPA / Dashboard). Append R after 1–3 or a–d to restart those units after deploy."
  echo "  ${C_GREEN}0${C_RESET} deploy + restart ${C_BOLD}all 9 HTTP${C_RESET} ${C_DIM}APIs${C_RESET}"
  echo "  ${C_GREEN}1${C_RESET} agent  ${C_GREEN}2${C_RESET} monitor  ${C_GREEN}3${C_RESET} ops"
  echo "  ${C_GREEN}a${C_RESET} architecture  ${C_GREEN}b${C_RESET} account  ${C_GREEN}c${C_RESET} research  ${C_GREEN}d${C_RESET} feed ${C_DIM}(massive)${C_RESET}"
  echo "  Examples: ${C_DIM}0${C_RESET} = sync+build+restart all HTTP · ${C_DIM}2R${C_RESET} = +restart bifrost-server · ${C_DIM}cR${C_RESET} = +restart research category · ${C_DIM}2${C_RESET} = deploy only (no systemctl)"
  echo "  ${C_DIM}Tip: use ${C_BOLD}2R${C_RESET} after UI changes so bifrost-server remounts frontend/dist. ${C_BOLD}q${C_RESET} or empty = cancel.${C_RESET}"
  while true; do
    echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Choice ${C_DIM}[0, 1-3, a-d, optional R, q to cancel]${C_RESET} "
    read -r _raw
    _raw=$(echo "${_raw}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    _norm=$(echo "${_raw}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [[ -z "${_norm}" || "${_norm}" == "q" ]]; then
      _msg_info "Cancelled."
      return 0
    fi
    _reset_run_state
    _qd_ec=0
    if [[ "${_norm}" == "0" ]]; then
      DO_DEPLOY=1
      ACTION=restart
      RESTART_ALL_APIS=1
      echo "${C_CYAN}→ deploy + sudo systemctl restart (all 9 HTTP APIs)${C_RESET}"
      _run_pipeline && _qd_ec=0 || _qd_ec=$?
      break
    fi
    if [[ "${_norm}" =~ ^([1-3])(r)?$ ]]; then
      _digit="${BASH_REMATCH[1]}"
      _want_r="${BASH_REMATCH[2]}"
      if [[ -n "${_want_r}" ]]; then
        DO_DEPLOY=1
        ACTION=restart
        case "${_digit}" in
          1) _restart_add_unit bifrost-agent ;;
          2) _restart_add_unit bifrost-server ;;
          3) _restart_add_unit bifrost-ops ;;
        esac
        echo "${C_CYAN}→ deploy + sudo systemctl restart …${C_RESET}"
      else
        DO_DEPLOY_ONLY=1
        echo "${C_CYAN}→ deploy only (rsync --delete + build, no systemctl)${C_RESET}"
      fi
      _run_pipeline && _qd_ec=0 || _qd_ec=$?
      break
    fi
    if [[ "${_norm}" =~ ^([abcd])(r)?$ ]]; then
      _ltr="${BASH_REMATCH[1]}"
      _want_r="${BASH_REMATCH[2]}"
      if [[ -n "${_want_r}" ]]; then
        DO_DEPLOY=1
        ACTION=restart
        case "${_ltr}" in
          a) RESTART_CATEGORY=architecture ;;
          b) RESTART_CATEGORY=account ;;
          c) RESTART_CATEGORY=research ;;
          d) RESTART_CATEGORY=feed ;;
        esac
        echo "${C_CYAN}→ deploy + sudo systemctl restart (HTTP category)${C_RESET}"
      else
        DO_DEPLOY_ONLY=1
        echo "${C_CYAN}→ deploy only (rsync --delete + build, no systemctl)${C_RESET}"
      fi
      _run_pipeline && _qd_ec=0 || _qd_ec=$?
      break
    fi
    _msg_warn "Invalid — use 0, 1–3 or a–d, optional R (e.g. 2R, cR), q or empty to cancel."
  done
  return 0
}

# Run scripts/<name> from repo root with .venv if present (local Dev DB tools).
_local_run_python_script() {
  local _script="$1"
  shift
  cd "${PROJECT_ROOT}" || return 1
  if [[ ! -f "scripts/${_script}" ]]; then
    echo "ERROR: scripts/${_script} not found under ${PROJECT_ROOT}" >&2
    return 1
  fi
  if [[ -f .venv/bin/activate ]]; then
    # shellcheck source=/dev/null
    source .venv/bin/activate
  fi
  python "scripts/${_script}" "$@"
}

# Local (this Mac): pgrep Socket ingest + Celery — same scripts as SubprocessLocalExecutor
# (backend/ops/services/executor_local.py). Helps debug “process running but Settings Socket/Celery empty”.
_cli_local_mac_subprocess_check() {
  cd "${PROJECT_ROOT}" || return 1
  local root_lc
  root_lc=$(echo "${PROJECT_ROOT}" | tr '[:upper:]' '[:lower:]')

  echo ""
  echo "${C_BLUE}${C_BOLD}=== Local Mac — Bifrost subprocess scan ===${C_RESET}"
  echo "${C_DIM}Repo:${C_RESET} ${PROJECT_ROOT}"
  echo "${C_DIM}Time:${C_RESET} $(date '+%Y-%m-%d %H:%M:%S %z')"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "${C_DIM}Host:${C_RESET} Darwin (typical: Ops ops.local_control=subprocess)"
  else
    echo "${C_YELLOW}Note:${C_RESET} Not macOS — prod Linux uses systemd on ${DEPLOY_HOST}; this scan is still local pgrep only."
  fi
  echo ""
  echo "${C_BOLD}UI hint:${C_RESET} App Settings → Ops / Socket / Celery must target the Ops instance on ${C_DIM}this${C_RESET} machine if you expect these PIDs."
  echo "${C_BOLD}Pidfiles:${C_RESET} ${C_DIM}logs/.ops-ingest-*.pid${C_RESET} are written when Ops starts ingest via subprocess; stale files mean UI/Ops state can disagree with pgrep."
  echo ""

  _bifrost_local_scan_script() {
    local pattern="$1"
    local title="$2"
    echo "${C_CYAN}${title}${C_RESET}"
    local pids
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [[ -z "${pids}" ]]; then
      echo "  ${C_DIM}NOT RUNNING (no pgrep match for this pattern)${C_RESET}"
      echo ""
      return 0
    fi
    local pid cmd match
    for pid in ${pids}; do
      cmd=$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
      if [[ -z "${cmd}" ]]; then
        echo "  PID ${pid}: ${C_YELLOW}(process ended — pgrep race)${C_RESET}"
        continue
      fi
      match="other"
      if [[ "${cmd}" == *"${PROJECT_ROOT}"* ]]; then
        match="this_repo"
      elif echo "${cmd}" | grep -Fqi "${root_lc}"; then
        match="casefold"
      fi
      case "${match}" in
        this_repo)
          echo "  ${C_GREEN}RUNNING${C_RESET} PID=${pid} ${C_DIM}(command line contains this repo path)${C_RESET}"
          ;;
        casefold)
          echo "  ${C_YELLOW}RUNNING${C_RESET} PID=${pid} ${C_DIM}(case-insensitive path match — confirm it is this clone)${C_RESET}"
          ;;
        *)
          echo "  ${C_YELLOW}RUNNING${C_RESET} PID=${pid} ${C_DIM}(path does not match this repo — other clone or wrapper?)${C_RESET}"
          ;;
      esac
      echo "    ${C_DIM}${cmd}${C_RESET}"
    done
    echo ""
  }

  _bifrost_local_pidfile() {
    local rel="$1"
    local title="$2"
    local path="${PROJECT_ROOT}/${rel}"
    echo "${C_CYAN}${title} ${C_DIM}(${rel})${C_RESET}"
    if [[ ! -f "${path}" ]]; then
      echo "  ${C_DIM}(no pidfile)${C_RESET}"
      echo ""
      return 0
    fi
    local pid
    pid=$(tr -d ' \t\n\r' < "${path}" | head -c 32)
    if ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
      echo "  ${C_RED}invalid pidfile${C_RESET}: ${pid:-empty}"
      echo ""
      return 0
    fi
    if kill -0 "${pid}" 2>/dev/null; then
      local c
      c=$(ps -p "${pid}" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
      echo "  ${C_GREEN}PID ${pid} alive${C_RESET}"
      [[ -n "${c}" ]] && echo "    ${C_DIM}${c}${C_RESET}"
    else
      echo "  ${C_RED}STALE${C_RESET}: pidfile points to ${pid} (not running)"
    fi
    echo ""
  }

  _bifrost_local_scan_script 'scripts/run_massive_ws\.py' 'Massive WebSocket ingest (run_massive_ws.py)'
  _bifrost_local_scan_script 'scripts/run_ib_ingestor\.py' 'IB ingestor (run_ib_ingestor.py)'
  _bifrost_local_scan_script 'scripts/run_ib_operator\.py' 'IB operator RPC (run_ib_operator.py)'
  _bifrost_local_scan_script 'scripts/run_celery\.py' 'Celery worker (run_celery.py)'

  echo "${C_BOLD}Ops ingest pidfiles${C_RESET} ${C_DIM}(SubprocessLocalExecutor)${C_RESET}"
  _bifrost_local_pidfile 'logs/.ops-ingest-massive-ws.pid' 'massive-ws'
  _bifrost_local_pidfile 'logs/.ops-ingest-ib-operator.pid' 'ib-operator'
  _bifrost_local_pidfile 'logs/.ops-ingest-ib-ingestor.pid' 'ib-ingestor'

  echo "${C_DIM}--- end ---${C_RESET}"
}

# SSH to DEPLOY_HOST: systemctl scan for prod Linux (grouped HTTP + ingest + worker@*).
_cli_remote_services_systemd_scan() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  _bifrost_restore_session_sudo
  local _arch _acct _res _feed
  _arch=$(printf '%s ' "${BIFROST_CATEGORY_ARCHITECTURE[@]}")
  _acct=$(printf '%s ' "${BIFROST_CATEGORY_ACCOUNT[@]}")
  _res=$(printf '%s ' "${BIFROST_CATEGORY_RESEARCH[@]}")
  _feed=$(printf '%s ' "${BIFROST_CATEGORY_FEED[@]}")
  _socket=$(printf '%s ' "${BIFROST_CATEGORY_SOCKET_SERVICES[@]}")
  _emit_remote_scan_body() {
    cat <<EOF
set -euo pipefail
export SYSTEMD_PAGER=cat
_line() {
  local u act sub mp
  u="\$1"
  printf '%s: ' "\$u"
  act=\$(systemctl is-active "\$u" 2>/dev/null || true)
  sub=\$(systemctl show "\$u" -p SubState --value 2>/dev/null || true)
  mp=\$(systemctl show "\$u" -p MainPID --value 2>/dev/null || true)
  if [[ "\$act" == "active" ]]; then
    echo "RUNNING (SubState=\${sub:-?}, MainPID=\${mp:-0})"
  elif [[ -n "\$act" ]]; then
    echo "NOT RUNNING (ActiveState=\$act\${sub:+, SubState=\$sub})"
  else
    echo "NOT RUNNING (unit not found or not readable — retry with sudo, e.g. -p PASSWORD)"
  fi
}
_block() {
  local u
  echo ""
  echo "--- \$1 ---"
  shift
  for u in "\$@"; do
    _line "\$u"
  done
}
echo "=== Bifrost systemd scan (${DEPLOY_USER}@${DEPLOY_HOST}) ==="
echo "Repo on server (expected): ${DEPLOY_PATH}"
echo "Time: \$(date '+%Y-%m-%d %H:%M:%S %z')"
_block "Core (server+celery)" bifrost-server bifrost-celery
_block "HTTP · Architecture" ${_arch}
_block "HTTP · Account (trading+portfolio)" ${_acct}
_block "HTTP · Research (market+research+strategy)" ${_res}
_block "HTTP · Feed (massive)" ${_feed}
_block "Socket Services (ingest/IB edge)" ${_socket}
_block "Daemon (trading engine + agent + account sync)" bifrost-engine bifrost-agent bifrost-account-sync
echo ""
echo "--- bifrost-celery-worker@*.service (template instances) ---"
if out=\$(systemctl list-units 'bifrost-celery-worker@*.service' --all --no-legend --no-pager 2>/dev/null); then
  if [[ -z "\$(echo "\$out" | tr -d '[:space:]')" ]]; then
    echo "  (none loaded)"
  else
    echo "\$out"
  fi
else
  echo "  (list-units failed — check systemd version / permissions)"
fi
echo ""
echo "--- end ---"
EOF
  }
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    {
      printf '%s\n' "${SUDO_PASSWORD}"
      _emit_remote_scan_body
    } | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' bash -s"
  else
    _emit_remote_scan_body | ssh_remote_stdin_pipe "${REMOTE}" bash -s
  fi
}

# Interactive: 1=Dev (local --dev) 2=Prod (remote --prod). Prints dev|prod to stdout.
# Must print prompts to stderr: callers use _env="$(...)" and stdout is captured — only the
# final dev|prod must go to stdout, or the user sees nothing and read blocks on a hidden prompt.
_interactive_pick_db_env() {
  local _pick
  echo "" >&2
  echo "  ${C_DIM}1)${C_RESET} Dev — this machine (${C_DIM}--dev${C_RESET}, local repo + .venv)" >&2
  echo "  ${C_DIM}2)${C_RESET} Prod — ${DEPLOY_HOST} (${C_DIM}--prod${C_RESET} on ${DEPLOY_PATH})" >&2
  echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Target ${C_DIM}[1|2, default 2]${C_RESET} " >&2
  read -r _pick
  _pick=$(echo "${_pick}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case "${_pick}" in
    1|d|dev) printf '%s' dev ;;
    ""|2|p|prod) printf '%s' prod ;;
    *)
      _msg_warn "Invalid choice — using Prod."
      printf '%s' prod
      ;;
  esac
}

# Refresh BIFROST_INTERACTIVE_STATUS_* from DEPLOY_HOST (same units as menu s Status banner / --status grouping).
_bifrost_interactive_capture_remote_status() {
  local _raw _ec
  _bifrost_restore_session_sudo
  set +e
  _raw="$(_bifrost_remote_print_unit_status "$(_bifrost_status_systemd_units_space)" 2>&1)"
  _ec=$?
  set -e
  BIFROST_INTERACTIVE_STATUS_RAW="${_raw}"
  BIFROST_INTERACTIVE_STATUS_AT="$(date '+%Y-%m-%d %H:%M:%S')"
  return "${_ec}"
}

# Interactive menu s (Status): systemd units on DEPLOY_HOST; store summary for banner (no sub-prompt).
_interactive_show_status() {
  local _ec
  _msg_info "Fetching status (all bifrost units) on ${DEPLOY_HOST} …"
  echo ""
  _bifrost_interactive_capture_remote_status
  _ec=$?
  if [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]]; then
    {
      echo "--- Status refresh (${BIFROST_INTERACTIVE_STATUS_AT}) exit ${_ec} ---"
      echo "${BIFROST_INTERACTIVE_STATUS_RAW}"
    } >"${BIFROST_SSH_LAST_LOG}"
  fi
  _msg_info "Status refresh finished (exit ${_ec}). Redrawing menu…"
  return 0
}

# Interactive menu db1: db_refresh_schema.py --dev (local) or --prod (remote).
_interactive_db_refresh_schema() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local _ec _env
  _env="$(_interactive_pick_db_env)"
  if [[ "${_env}" == "dev" ]]; then
    _msg_info "Local: python scripts/db_refresh_schema.py --dev …"
    echo ""
    if [[ ! -f "${PROJECT_ROOT}/.venv/bin/activate" ]]; then
      _msg_warn "No .venv at repo root — install deps or create venv; run may fail."
    fi
    set +e
    # FORCE_COLOR: piped to tee → stderr not a TTY; script honors env (see db_refresh_schema.py).
    FORCE_COLOR=1 _local_run_python_script db_refresh_schema.py --dev 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
    _ec=${PIPESTATUS[0]}
    set -e
  else
    _bifrost_restore_session_sudo
    _msg_info "Remote ${DEPLOY_HOST}: python scripts/db_refresh_schema.py --prod …"
    echo ""
    set +e
    ssh_remote_tty "${REMOTE}" DEPLOY_PATH="${DEPLOY_PATH}" bash -s <<'REMOTE_DB_REFRESH_EOF' 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
set -euo pipefail
cd "$DEPLOY_PATH"
if [[ ! -f .venv/bin/activate ]]; then
  echo "ERROR: .venv missing on remote. Run Deploy (menu d or 2) once to create venv and sync code." >&2
  exit 1
fi
# shellcheck source=/dev/null
source .venv/bin/activate
export FORCE_COLOR=1
python scripts/db_refresh_schema.py --prod
REMOTE_DB_REFRESH_EOF
    _ec=${PIPESTATUS[0]}
    set -e
  fi
  {
    echo ""
    echo "--- exit code: ${_ec} ---"
  } | tee -a "${BIFROST_SSH_LAST_LOG}"
  _msg_info "DB schema refresh finished (exit ${_ec}). Redrawing menu…"
  return 0
}

# Interactive menu db2: db_release_dblock.py --dev (local) or --prod (remote); dry-run then optional --yes.
_interactive_db_release_locks() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local _ec _ans _env _term_q
  _env="$(_interactive_pick_db_env)"
  if [[ "${_env}" == "dev" ]]; then
    _term_q="python scripts/db_release_dblock.py --dev --yes"
    _msg_info "Step 1/2 (local): db_release_dblock.py --dev --dry-run …"
    if [[ ! -f "${PROJECT_ROOT}/.venv/bin/activate" ]]; then
      _msg_warn "No .venv at repo root — run may fail."
    fi
  else
    _term_q="python scripts/db_release_dblock.py --prod --yes"
    _bifrost_restore_session_sudo
    _msg_info "Step 1/2 (remote): db_release_dblock.py --prod --dry-run …"
  fi
  echo ""
  set +e
  if [[ "${_env}" == "dev" ]]; then
    _local_run_python_script db_release_dblock.py --dev --dry-run 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
  else
    ssh_remote_tty "${REMOTE}" DEPLOY_PATH="${DEPLOY_PATH}" bash -s <<'REMOTE_DB_REL_DRY_EOF' 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
set -euo pipefail
cd "$DEPLOY_PATH"
if [[ ! -f .venv/bin/activate ]]; then
  echo "ERROR: .venv missing on remote. Run Deploy (menu d or 2) first." >&2
  exit 1
fi
# shellcheck source=/dev/null
source .venv/bin/activate
python scripts/db_release_dblock.py --prod --dry-run
REMOTE_DB_REL_DRY_EOF
  fi
  _ec=${PIPESTATUS[0]}
  {
    echo ""
    echo "--- dry-run exit code: ${_ec} ---"
  } | tee -a "${BIFROST_SSH_LAST_LOG}"
  set -e
  echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Run terminate (${_term_q})? ${C_DIM}[y/N]${C_RESET} "
  read -r _ans
  _ans=$(echo "${_ans}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ "${_ans}" != "y" && "${_ans}" != "yes" ]]; then
    _msg_info "Skipped terminate. Output above was dry-run only."
    return 0
  fi
  if [[ "${_env}" == "dev" ]]; then
    _msg_info "Step 2/2 (local): db_release_dblock.py --dev --yes …"
  else
    _msg_info "Step 2/2 (remote): db_release_dblock.py --prod --yes …"
  fi
  echo ""
  set +e
  if [[ "${_env}" == "dev" ]]; then
    _local_run_python_script db_release_dblock.py --dev --yes 2>&1 | tee -a "${BIFROST_SSH_LAST_LOG}"
  else
    ssh_remote_tty "${REMOTE}" DEPLOY_PATH="${DEPLOY_PATH}" bash -s <<'REMOTE_DB_REL_YES_EOF' 2>&1 | tee -a "${BIFROST_SSH_LAST_LOG}"
set -euo pipefail
cd "$DEPLOY_PATH"
# shellcheck source=/dev/null
source .venv/bin/activate
python scripts/db_release_dblock.py --prod --yes
REMOTE_DB_REL_YES_EOF
  fi
  _ec=${PIPESTATUS[0]}
  {
    echo ""
    echo "--- exit code: ${_ec} ---"
  } | tee -a "${BIFROST_SSH_LAST_LOG}"
  set -e
  _msg_info "DB lock release finished (exit ${_ec}). Redrawing menu…"
  return 0
}

# Non-interactive: remote db_refresh_schema.py --prod.
_cli_remote_db_refresh_schema() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  _bifrost_restore_session_sudo
  ssh_remote_tty "${REMOTE}" DEPLOY_PATH="${DEPLOY_PATH}" bash -s <<'REMOTE_DB_REFRESH_EOF'
set -euo pipefail
cd "$DEPLOY_PATH"
if [[ ! -f .venv/bin/activate ]]; then
  echo "ERROR: .venv missing on remote. Deploy first: ./scripts/bifrost_ssh.sh --deploy-only" >&2
  exit 1
fi
source .venv/bin/activate
export FORCE_COLOR=1
python scripts/db_refresh_schema.py --prod
REMOTE_DB_REFRESH_EOF
}

# Non-interactive: local db_refresh_schema.py --dev.
_cli_local_db_refresh_schema() {
  if [[ ! -f "${PROJECT_ROOT}/.venv/bin/activate" ]]; then
    _msg_warn "No .venv at ${PROJECT_ROOT}; run may fail."
  fi
  FORCE_COLOR=1 _local_run_python_script db_refresh_schema.py --dev
}

# Non-interactive: remote db_release_dblock.py --prod ($1 empty or --yes).
_cli_remote_db_release_locks() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local extra="--dry-run"
  if [[ "${1:-}" == "--yes" ]]; then
    extra="--yes"
  fi
  _bifrost_restore_session_sudo
  # shellcheck disable=SC2086
  ssh_remote_tty "${REMOTE}" bash -s <<EOF
set -euo pipefail
cd "${DEPLOY_PATH}"
if [[ ! -f .venv/bin/activate ]]; then
  echo "ERROR: .venv missing on remote. Deploy first." >&2
  exit 1
fi
# shellcheck source=/dev/null
source .venv/bin/activate
python scripts/db_release_dblock.py --prod ${extra}
EOF
}

# Non-interactive: local db_release_dblock.py --dev ($1 empty or --yes).
_cli_local_db_release_locks() {
  local extra="--dry-run"
  if [[ "${1:-}" == "--yes" ]]; then
    extra="--yes"
  fi
  if [[ ! -f "${PROJECT_ROOT}/.venv/bin/activate" ]]; then
    _msg_warn "No .venv at ${PROJECT_ROOT}; run may fail."
  fi
  # shellcheck disable=SC2086
  _local_run_python_script db_release_dblock.py --dev ${extra}
}

# Local (Mac/repo): write deploy/nginx/bifrost-status.conf from merged prod YAML before rsync to server.
_bifrost_local_render_nginx_status_conf_prod() {
  local py="${PROJECT_ROOT}/.venv/bin/python"
  [[ -x "${py}" ]] || py="python3"
  local cfg="${PROJECT_ROOT}/config/config.prod.yaml"
  local rs="${PROJECT_ROOT}/scripts/render_nginx_status_conf.py"
  if [[ ! -f "${rs}" ]]; then
    _msg_warn "Missing ${rs}; skip local nginx render."
    return 1
  fi
  if [[ ! -f "${cfg}" ]]; then
    _msg_warn "Missing ${cfg}; skip local nginx render (need prod overlay for merged server ports)."
    return 1
  fi
  _msg_info "Local: python scripts/render_nginx_status_conf.py (BIFROST_CONFIG=config/config.prod.yaml) …"
  (cd "${PROJECT_ROOT}" && BIFROST_CONFIG="${cfg}" "${py}" scripts/render_nginx_status_conf.py)
}

# Push generated bifrost-status.conf to remote repo tree (then remote sudo copies it into /etc/nginx).
_bifrost_rsync_nginx_bifrost_status_conf() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local src="${PROJECT_ROOT}/deploy/nginx/bifrost-status.conf"
  if [[ ! -f "${src}" ]]; then
    _msg_warn "Missing ${src}; skip rsync nginx conf."
    return 1
  fi
  _msg_info "rsync deploy/nginx/bifrost-status.conf → ${REMOTE}:${DEPLOY_PATH}/deploy/nginx/"
  local _ngx_dir_q
  _ngx_dir_q=$(printf '%q' "${DEPLOY_PATH}/deploy/nginx")
  ssh_remote "${REMOTE}" "mkdir -p ${_ngx_dir_q}"
  if [[ -n "${SSH_CONTROL_PATH}" ]]; then
    rsync -avz -e "ssh -S ${SSH_CONTROL_PATH}" "${src}" "${REMOTE}:${DEPLOY_PATH}/deploy/nginx/"
  elif _use_sshpass_for_ssh; then
    SSHPASS="${SUDO_PASSWORD}" rsync -avz -e "sshpass -e ssh" "${src}" "${REMOTE}:${DEPLOY_PATH}/deploy/nginx/"
  else
    rsync -avz -e ssh "${src}" "${REMOTE}:${DEPLOY_PATH}/deploy/nginx/"
  fi
}

# Remote: register deploy/systemd/*.service and *.target with systemd and daemon-reload (requires sudo).
# - Prefer: systemctl enable /absolute/path/foo.service (symlink under /etc/systemd/system; works if repo path is stable).
# - Fallback: cp to /etc/systemd/system/.
# - Only password goes to sudo stdin: printf password | sudo -S bash -c "$(printf '%q' script)" — no nested heredocs
#   (macOS bash 3.2 can misparse nested heredocs sent over ssh, leaving install a no-op).
_cli_remote_install_systemd_units() {
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local _ec=0
  local _qpath
  local _remote_install_body
  local _remote_install_q
  _qpath=$(printf '%q' "${DEPLOY_PATH}")
  _bifrost_restore_session_sudo

  # 0) Local render from merged prod YAML, then rsync nginx site file to server (before systemd/nginx install on host).
  set +e
  _bifrost_local_render_nginx_status_conf_prod
  _lr=$?
  set -e
  if [[ ${_lr} -ne 0 ]]; then
    _msg_warn "Local nginx render failed; rsync may push a stale deploy/nginx/bifrost-status.conf."
  fi
  set +e
  _bifrost_rsync_nginx_bifrost_status_conf
  _rs=$?
  set -e
  if [[ ${_rs} -ne 0 ]]; then
    _msg_warn "rsync nginx conf failed; remote ${DEPLOY_PATH}/deploy/nginx/bifrost-status.conf may be outdated (run --deploy-only or fix SSH)."
  fi

  # 1) No sudo: verify repo path and that bifrost-massive.service exists in the synced tree.
  ssh_remote_stdin_pipe "${REMOTE}" \
    DEPLOY_PATH="${DEPLOY_PATH}" \
    bash -s <<'VERIFY_EOF'
set -euo pipefail
SRC="${DEPLOY_PATH}/deploy/systemd"
echo "Checking ${SRC} ..."
if [[ ! -d "${SRC}" ]]; then
  echo "ERROR: missing directory ${SRC}. Sync repo first (e.g. --deploy-only). If your tree lives elsewhere, set DEPLOY_PATH." >&2
  exit 1
fi
ls -la "${SRC}"
if [[ ! -f "${SRC}/bifrost-massive.service" ]]; then
  echo "ERROR: ${SRC}/bifrost-massive.service not found — deploy may be stale or DEPLOY_PATH is wrong on this host." >&2
  exit 1
fi
if [[ ! -f "${SRC}/bifrost-research.service" ]]; then
  echo "ERROR: ${SRC}/bifrost-research.service not found — sync repo or add deploy/systemd/bifrost-research.service." >&2
  exit 1
fi
VERIFY_EOF
  _ec=$?
  if [[ ${_ec} -ne 0 ]]; then
    return "${_ec}"
  fi

  # 2) One sudo invocation: body passed only via bash -c (stdin = password only). DEPLOY_PATH via env.
  _remote_install_body=$(cat <<'REMOTE_INSTALL_BODY'
set -euo pipefail
shopt -s nullglob
SRC="${DEPLOY_PATH}/deploy/systemd"
if [[ ! -f "${SRC}/bifrost-massive.service" ]] || [[ ! -f "${SRC}/bifrost-research.service" ]]; then
  echo "ERROR: missing ${SRC}/bifrost-massive.service or bifrost-research.service" >&2
  exit 1
fi
for f in "${SRC}"/*.service "${SRC}"/*.target; do
  [[ -f "$f" ]] || continue
  bn=$(basename "$f")
  dest="/etc/systemd/system/${bn}"
  echo "Registering ${bn} ..."
  if systemctl enable "$f" 2>/dev/null; then
    echo "  systemctl enable $f"
  elif cp -f "$f" "$dest" 2>/dev/null; then
    echo "  cp -> ${dest}"
  else
    # systemctl enable may have left a symlink to $f; cp then errors "same file".
    _rsrc=$(readlink -f "$f" 2>/dev/null || true)
    _rdst=$(readlink -f "$dest" 2>/dev/null || true)
    if [[ -n "${_rsrc}" ]] && [[ "${_rsrc}" == "${_rdst}" ]]; then
      echo "  ${bn} already installed (symlink or same path as repo); OK"
    elif rm -f "$dest" && cp -f "$f" "$dest"; then
      echo "  cp -> ${dest} (replaced previous link/copy)"
    else
      echo "ERROR: could not register ${f}" >&2
      exit 1
    fi
  fi
done
systemctl daemon-reload
# Do not rely on list-unit-files | grep — output format/pager/alias can differ; LoadState is authoritative.
export SYSTEMD_PAGER=cat
_load=$(systemctl show bifrost-massive.service -p LoadState --value 2>/dev/null || true)
_load_r=$(systemctl show bifrost-research.service -p LoadState --value 2>/dev/null || true)
if [[ -z "${_load}" ]] || [[ "${_load}" == "not-found" ]]; then
  echo "ERROR: bifrost-massive.service LoadState=${_load:-empty} (systemd does not see the unit). Check symlink/cp under /etc/systemd/system/." >&2
  ls -la /etc/systemd/system/bifrost-massive.service 2>&1 || true
  systemctl status bifrost-massive.service --no-pager -l 2>&1 || true
  exit 1
fi
if [[ -z "${_load_r}" ]] || [[ "${_load_r}" == "not-found" ]]; then
  echo "ERROR: bifrost-research.service LoadState=${_load_r:-empty} (systemd does not see the unit). Check deploy/systemd/bifrost-research.service is synced." >&2
  ls -la /etc/systemd/system/bifrost-research.service 2>&1 || true
  exit 1
fi
# Nginx: use bifrost-status.conf rsync’d from the operator machine (local render + rsync in bifrost_ssh.sh).
NGX_SRC="${DEPLOY_PATH}/deploy/nginx/bifrost-status.conf"
if [[ -f "${NGX_SRC}" ]] && command -v nginx >/dev/null 2>&1; then
  echo "Nginx: installing site bifrost-status from ${NGX_SRC} ..."
  install -m0644 "${NGX_SRC}" /etc/nginx/sites-available/bifrost-status 2>/dev/null || cp -f "${NGX_SRC}" /etc/nginx/sites-available/bifrost-status
  ln -sf /etc/nginx/sites-available/bifrost-status /etc/nginx/sites-enabled/bifrost-status
  if nginx -t; then
    if systemctl reload nginx 2>/dev/null; then
      echo "OK: nginx reloaded (bifrost-status site updated)."
    elif service nginx reload 2>/dev/null; then
      echo "OK: nginx reloaded via service(8)."
    else
      echo "WARN: nginx -t OK but reload failed; run: sudo systemctl reload nginx" >&2
    fi
  else
    echo "WARN: nginx -t failed after updating site file; fix nginx config before reload." >&2
  fi
else
  echo "INFO: skip nginx (no ${NGX_SRC} or nginx not installed). Use deploy/nginx/install_on_server.sh on the host if needed."
fi
echo "OK: bifrost-massive.service LoadState=${_load}; bifrost-research.service LoadState=${_load_r}. Next: sudo systemctl enable --now API units as needed."
REMOTE_INSTALL_BODY
)
  _remote_install_q=$(printf '%q' "${_remote_install_body}")

  if [[ -n "${SUDO_PASSWORD}" ]]; then
    printf '%s\n' "${SUDO_PASSWORD}" | ssh_remote_stdin_pipe "${REMOTE}" "sudo -S -p '' env DEPLOY_PATH=${_qpath} bash -c ${_remote_install_q}"
    _ec=$?
  elif [[ -r /dev/tty ]]; then
    ssh_remote -tt "${REMOTE}" "sudo env DEPLOY_PATH=${_qpath} bash -c ${_remote_install_q}" </dev/tty
    _ec=$?
  else
    _msg_warn "No sudo password and no /dev/tty; trying sudo -n …"
    set +e
    ssh_remote "${REMOTE}" "sudo -n env DEPLOY_PATH=${_qpath} bash -c ${_remote_install_q}"
    _ec=$?
    set -e
    if [[ ${_ec} -ne 0 ]]; then
      _msg_err "sudo -n failed; use --password / -p, interactive mode, or NOPASSWD for sudo."
    fi
  fi
  return "${_ec}"
}

# Append sorted list of deploy/systemd *.service and *.target (what the install loop registers).
_bifrost_append_deploy_systemd_files_summary_to_log() {
  local log="$1"
  local d="${PROJECT_ROOT}/deploy/systemd"
  local _tmp
  _tmp="$(mktemp -t bifrost_sysd_units)"
  {
    echo ""
    echo "--- Repo unit files processed by install (deploy/systemd) ---"
    if [[ ! -d "${d}" ]]; then
      echo "  (missing on this machine: ${d})"
    else
      (
        shopt -s nullglob
        local _f
        for _f in "${d}"/*.service "${d}"/*.target; do
          [[ -f "${_f}" ]] && basename "${_f}"
        done | sort -u
      ) >"${_tmp}"
      if [[ ! -s "${_tmp}" ]]; then
        echo "  (no .service or .target files)"
      else
        while IFS= read -r _b; do
          [[ -n "${_b}" ]] && echo "  ${_b}"
        done <"${_tmp}"
      fi
    fi
  } >>"${log}"
  rm -f "${_tmp}"
}

# Interactive menu tl1: install systemd unit files from synced repo.
_interactive_install_systemd_units() {
  local _ec _sum_ec _lc
  _bifrost_restore_session_sudo
  _msg_info "Local render + rsync nginx conf, then remote: register ${DEPLOY_PATH}/deploy/systemd + install nginx site if present …"
  echo ""
  set +e
  _cli_remote_install_systemd_units 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
  _ec=${PIPESTATUS[0]}
  set -e
  {
    echo ""
    echo "--- exit code: ${_ec} ---"
  } >>"${BIFROST_SSH_LAST_LOG}"
  if [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]]; then
    _bifrost_append_deploy_systemd_files_summary_to_log "${BIFROST_SSH_LAST_LOG}"
  fi
  _msg_info "systemd install finished (exit ${_ec}). Fetching unit summary (same as menu s Status) …"
  echo ""
  _bifrost_interactive_capture_remote_status
  _sum_ec=$?
  if [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]]; then
    {
      echo ""
      echo "--- Unit summary (${BIFROST_INTERACTIVE_STATUS_AT}) exit ${_sum_ec} ---"
      _bifrost_cli_print_status_grouped "${BIFROST_INTERACTIVE_STATUS_RAW}" "${BIFROST_STATUS_ROWS[@]}"
    } >>"${BIFROST_SSH_LAST_LOG}"
  fi
  # Widen Last output so install log + file list + grouped summary are visible (cap avoids huge terminals).
  if [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]] && [[ -f "${BIFROST_SSH_LAST_LOG}" ]]; then
    _lc=$(wc -l <"${BIFROST_SSH_LAST_LOG}" | tr -d ' ')
    if [[ "${_lc}" -gt 200 ]]; then
      BIFROST_SSH_LAST_OUTPUT_LINES=220
    elif [[ "${_lc}" -gt 120 ]]; then
      BIFROST_SSH_LAST_OUTPUT_LINES=200
    else
      BIFROST_SSH_LAST_OUTPUT_LINES=120
    fi
  else
    BIFROST_SSH_LAST_OUTPUT_LINES=120
  fi
  _msg_info "Repo unit list + unit summary appended; top banner updated. Last output pane widened to ${BIFROST_SSH_LAST_OUTPUT_LINES} lines. Redrawing menu…"
  return 0
}

# Map token -> bifrost unit name, ALL*, or CAT_*.
# Digits 1–3 match Deploy / Reboot services legend: 1=agent 2=bifrost-server 3=bifrost-ops (bifrost-engine: Dashboard only). Letters a–d = HTTP categories.
_interactive_map_unit_token() {
  case "$1" in
    0) echo ALL_HTTP ;;
    1|agent|bifrost-agent) echo bifrost-agent ;;
    2|monitor|server|bifrost-server) echo bifrost-server ;;
    3|ops|o|bifrost-ops) echo bifrost-ops ;;
    a|architecture|arch) echo CAT_ARCH ;;
    b|account|acct) echo CAT_ACCOUNT ;;
    c|research|res) echo CAT_RESEARCH ;;
    d|feed) echo CAT_FEED ;;
    both|all-three|all3|core|pair|all) echo ALL ;;
    all-stack|full|everything) echo ALL_STACK ;;
    massive|m|bifrost-massive) echo bifrost-massive ;;
    docs|doc|bifrost-docs) echo bifrost-docs ;;
    trading|t|bifrost-trading) echo bifrost-trading ;;
    strategy|bifrost-strategy) echo bifrost-strategy ;;
    portfolio|bifrost-portfolio) echo bifrost-portfolio ;;
    market|bifrost-market) echo bifrost-market ;;
    bifrost-research|research-api) echo bifrost-research ;;
    apis|http-apis|all-http|all-apis) echo ALL_HTTP ;;
    *) echo "" ;;
  esac
}

# Map token -> start|stop|restart (empty if unknown).
_interactive_map_action_token() {
  case "$1" in
    1|start) echo start ;;
    2|stop) echo stop ;;
    3|restart) echo restart ;;
    *) echo "" ;;
  esac
}

# Interactive: systemctl — same unit keys as Deploy (1–3, 0=all HTTP, a–d categories) plus words (all-stack, massive, …).
_interactive_systemctl_one_service() {
  local _unit _act _t1 _t2 _u _a _line_lower _hx _digits _d1 _d2 _cl _ac_digit _cn _sc_ec
  echo ""
  echo "${C_BLUE}${C_BOLD}--- Reboot services ---${C_RESET}"
  _msg_info "Enter unit + action on one line (examples below)."
  echo "  ${C_GREEN}Units:${C_RESET}  ${C_DIM}1${C_RESET} agent  ${C_DIM}2${C_RESET} monitor  ${C_DIM}3${C_RESET} ops"
  echo "  ${C_GREEN}0${C_RESET} all 9 HTTP APIs  ${C_DIM}(same as apis / h3)${C_RESET}  ·  ${C_GREEN}a–d${C_RESET} architecture / account / research / feed"
  echo "  ${C_GREEN}Other words:${C_RESET} ${C_DIM}both${C_RESET} bifrost-server only · ${C_DIM}all-stack${C_RESET} · ${C_DIM}docs massive trading strategy portfolio market bifrost-research${C_RESET}"
  echo "  ${C_GREEN}Action:${C_RESET} ${C_DIM}1${C_RESET}=start ${C_DIM}2${C_RESET}=stop ${C_DIM}3${C_RESET}=restart"
  echo "  ${C_CYAN}Shorthand:${C_RESET} ${C_BOLD}11–33${C_DIM} = unit+action e.g. ${C_BOLD}23${C_DIM}=bifrost-server+restart · ${C_BOLD}01–03${C_DIM} = all HTTP+action · ${C_BOLD}a3${C_DIM}=architecture+restart · ${C_BOLD}h3${C_RESET}"
  echo "  ${C_DIM}empty or q = cancel${C_RESET} ${C_DIM}(0 is “all HTTP”, not cancel)${C_RESET}"
  while true; do
    echo -n "${C_GREEN}${C_BOLD}>${C_RESET} "
    read -r _line
    _line=$(echo "${_line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    if [[ -z "${_line}" || "${_line}" == "q" ]]; then
      _msg_info "Cancelled."
      return 0
    fi

    _line_lower="${_line}"
    if [[ "${_line_lower}" =~ ^h[123]$ ]]; then
      _hx="${_line_lower:1:1}"
      _a="$(_interactive_map_action_token "${_hx}")"
      if [[ -z "${_a}" ]]; then
        _msg_warn "Invalid h· — use h1 h2 or h3. Or q / empty to cancel."
        continue
      fi
      echo "${C_CYAN}→ sudo systemctl ${_a} ${BIFROST_HTTP_UNITS[*]}${C_RESET}"
      _reset_run_state
      ACTION="${_a}"
      RESTART_ALL_APIS=1
      _run_pipeline && _sc_ec=0 || _sc_ec=$?
      break
    fi

    # Letter + action: a3 = architecture + restart
    if [[ "${_line_lower}" =~ ^([abcd])([123])$ ]]; then
      _cl="${BASH_REMATCH[1]}"
      _ac_digit="${BASH_REMATCH[2]}"
      _a="$(_interactive_map_action_token "${_ac_digit}")"
      if [[ -z "${_a}" ]]; then
        _msg_warn "Invalid — use a1–a3, b1–b3, … (category + action)."
        continue
      fi
      case "${_cl}" in
        a) _cn=architecture ;;
        b) _cn=account ;;
        c) _cn=research ;;
        d) _cn=feed ;;
      esac
      echo "${C_CYAN}→ sudo systemctl ${_a} (${_cn} HTTP category)${C_RESET}"
      _reset_run_state
      ACTION="${_a}"
      RESTART_CATEGORY="${_cn}"
      _run_pipeline && _sc_ec=0 || _sc_ec=$?
      break
    fi

    _digits=$(echo "${_line}" | tr -cd '0-9')
    # 0 + action: 01 / 02 / 03 = all HTTP + start/stop/restart
    if [[ ${#_digits} -ge 2 ]]; then
      _d1="${_digits:0:1}"
      _d2="${_digits:1:1}"
      if [[ "${_d1}" == "0" && "${_d2}" == [123] ]]; then
        _a="$(_interactive_map_action_token "${_d2}")"
        if [[ -n "${_a}" ]]; then
          echo "${C_CYAN}→ sudo systemctl ${_a} ${BIFROST_HTTP_UNITS[*]}${C_RESET}"
          _reset_run_state
          ACTION="${_a}"
          RESTART_ALL_APIS=1
          _run_pipeline && _sc_ec=0 || _sc_ec=$?
          break
        fi
      fi
    fi

    # Unit 1–3 + action 1–3 (e.g. 23 = bifrost-server + restart)
    if [[ ${#_digits} -ge 2 ]]; then
      _d1="${_digits:0:1}"
      _d2="${_digits:1:1}"
      if [[ "${_d1}" == [123] && "${_d2}" == [123] ]]; then
        _u="$(_interactive_map_unit_token "${_d1}")"
        _a="$(_interactive_map_action_token "${_d2}")"
        if [[ -z "${_u}" || -z "${_a}" ]]; then
          _msg_warn "Invalid shorthand — use 11–33 (unit+action). Or q / empty to cancel."
          continue
        fi
        if [[ "${_u}" == "ALL" ]]; then
          echo "${C_CYAN}→ sudo systemctl ${_a} bifrost-server${C_RESET}"
        elif [[ "${_u}" == "ALL_STACK" ]]; then
          echo "${C_CYAN}→ sudo systemctl ${_a} ${BIFROST_FULL_STACK_UNITS[*]}${C_RESET}"
        elif [[ "${_u}" == "ALL_HTTP" ]]; then
          echo "${C_CYAN}→ sudo systemctl ${_a} ${BIFROST_HTTP_UNITS[*]}${C_RESET}"
        else
          echo "${C_CYAN}→ sudo systemctl ${_a} ${_u}${C_RESET}"
        fi
        _reset_run_state
        ACTION="${_a}"
        if [[ "${_u}" == "ALL" ]]; then
          RESTART_ALL=1
        elif [[ "${_u}" == "ALL_STACK" ]]; then
          RESTART_ALL_STACK=1
        elif [[ "${_u}" == "ALL_HTTP" ]]; then
          RESTART_ALL_APIS=1
        else
          _restart_add_unit "${_u}"
        fi
        _run_pipeline && _sc_ec=0 || _sc_ec=$?
        break
      fi
    fi

    set -- ${_line}
    if [[ $# -lt 2 ]]; then
      _msg_warn "Invalid input — two words (2 restart, 3 restart, 0 3, a restart) or shorthand 23, 33, 03, a3. q / empty = cancel."
      continue
    fi
    _t1="$1"
    _t2="$2"
    _u="$(_interactive_map_unit_token "${_t1}")"
    _a="$(_interactive_map_action_token "${_t2}")"
    if [[ -n "${_u}" && -n "${_a}" ]]; then
      _unit="${_u}"
      _act="${_a}"
    else
      _u="$(_interactive_map_unit_token "${_t2}")"
      _a="$(_interactive_map_action_token "${_t1}")"
      if [[ -n "${_u}" && -n "${_a}" ]]; then
        _unit="${_u}"
        _act="${_a}"
      else
        _msg_warn "Could not parse. Try 3 restart, 0 3, a restart, 33, 03, a3. q / empty = cancel."
        continue
      fi
    fi
    if [[ "${_unit}" == "ALL" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} bifrost-server${C_RESET}"
    elif [[ "${_unit}" == "ALL_STACK" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} ${BIFROST_FULL_STACK_UNITS[*]}${C_RESET}"
    elif [[ "${_unit}" == "ALL_HTTP" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} ${BIFROST_HTTP_UNITS[*]}${C_RESET}"
    elif [[ "${_unit}" == "CAT_ARCH" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} architecture category${C_RESET}"
    elif [[ "${_unit}" == "CAT_ACCOUNT" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} account (trading+portfolio)${C_RESET}"
    elif [[ "${_unit}" == "CAT_RESEARCH" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} research (market+research+strategy)${C_RESET}"
    elif [[ "${_unit}" == "CAT_FEED" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} feed (massive)${C_RESET}"
    else
      echo "${C_CYAN}→ sudo systemctl ${_act} ${_unit}${C_RESET}"
    fi
    _reset_run_state
    ACTION="${_act}"
    if [[ "${_unit}" == "ALL" ]]; then
      RESTART_ALL=1
    elif [[ "${_unit}" == "ALL_STACK" ]]; then
      RESTART_ALL_STACK=1
    elif [[ "${_unit}" == "ALL_HTTP" ]]; then
      RESTART_ALL_APIS=1
    elif [[ "${_unit}" == "CAT_ARCH" ]]; then
      RESTART_CATEGORY=architecture
    elif [[ "${_unit}" == "CAT_ACCOUNT" ]]; then
      RESTART_CATEGORY=account
    elif [[ "${_unit}" == "CAT_RESEARCH" ]]; then
      RESTART_CATEGORY=research
    elif [[ "${_unit}" == "CAT_FEED" ]]; then
      RESTART_CATEGORY=feed
    else
      _restart_add_unit "${_unit}"
    fi
    _run_pipeline && _sc_ec=0 || _sc_ec=$?
    break
  done
  return 0
}

interactive_mode() {
  echo ""
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  echo "${C_BLUE}${C_BOLD}  Bifrost SSH ${C_CYAN}(interactive)${C_RESET}"
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  _msg_info "Host ${C_BOLD}${DEPLOY_USER}@${DEPLOY_HOST}${C_RESET}  Path ${C_BOLD}${DEPLOY_PATH}${C_RESET}"
  echo "${C_DIM}SSH: ControlMaster reuses **login** only (that password is not saved).${C_RESET}"
  echo "${C_DIM}sudo: **separate** from SSH — needed for systemctl on the remote host (often the same password).${C_RESET}"
  echo ""

  if ! _ssh_control_start; then
    _msg_warn "Continuing without ControlMaster (each ssh/rsync may ask for password again)."
  fi

  BIFROST_SSH_TUI=1
  BIFROST_SSH_LAST_LOG="$(mktemp -t bifrost_ssh_last)"
  : >"${BIFROST_SSH_LAST_LOG}"
  trap '_ssh_control_cleanup; [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]] && rm -f "${BIFROST_SSH_LAST_LOG}"' EXIT INT TERM

  if [[ -n "${SUDO_PASSWORD}" ]]; then
    _msg_info "Using sudo password from ${C_DIM}--password / -p / DEPLOY_SUDO_PASSWORD${C_RESET}; skipping prompt (cleared on exit)."
    if ! command -v sshpass >/dev/null 2>&1; then
      _msg_warn "sshpass not installed: SSH/rsync may still ask for the ${C_BOLD}login${C_RESET} password (sudo uses -p). Install sshpass to reuse the same secret for SSH, or use SSH keys."
    fi
  else
    echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Remote sudo password (for systemctl; not SSH) ${C_DIM}(Enter = ask when restart runs)${C_RESET}: "
    read -r -s SUDO_PASSWORD || true
    SUDO_PASSWORD="${SUDO_PASSWORD//$'\r'/}"
    echo ""
    if [[ -z "${SUDO_PASSWORD}" ]]; then
      _msg_info "No sudo password stored — you will be prompted for sudo when a step runs systemctl (e.g. Deploy d/2 with R)."
    else
      _msg_info "sudo password kept in memory for this session (all menu actions) until you quit or choose tl2 Clear."
    fi
  fi
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    BIFROST_SESSION_SUDO_PASSWORD="${SUDO_PASSWORD}"
  fi

  while true; do
    _interactive_paint_full
    echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Choice ${C_DIM}[r/1 d/2 s/3 db1 db2 tl1 tl2 tl3 tl4 tl5 tl6 o v q]${C_RESET} "
    read -r _ch
    _ch=$(echo "${_ch}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    case "${_ch}" in
      db1)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_db_refresh_schema
        ;;
      db2)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_db_release_locks
        ;;
      tl1) _interactive_install_systemd_units ;;
      tl2)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        SUDO_PASSWORD=""
        BIFROST_SESSION_SUDO_PASSWORD=""
        echo "[INFO] Stored sudo password cleared." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      tl3)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _msg_info "Reconnecting SSH (output streams below; may take a few seconds)…"
        echo ""
        {
          _ssh_control_cleanup
          SSH_CONTROL_PATH=""
          _ssh_control_start
        } 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
        _rc9=${PIPESTATUS[0]}
        {
          echo ""
          echo "--- exit code: ${_rc9} ---"
        } >>"${BIFROST_SSH_LAST_LOG}"
        ;;
      tl4)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        set +e
        _cli_local_mac_subprocess_check 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
        _ec_l=${PIPESTATUS[0]}
        set -e
        {
          echo ""
          echo "--- exit code: ${_ec_l} ---"
        } >>"${BIFROST_SSH_LAST_LOG}"
        ;;
      tl5)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _bifrost_restore_session_sudo
        set +e
        _cli_remote_services_systemd_scan 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
        _ec_p=${PIPESTATUS[0]}
        set -e
        {
          echo ""
          echo "--- exit code: ${_ec_p} ---"
        } >>"${BIFROST_SSH_LAST_LOG}"
        ;;
      tl6|mkdocs)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_deploy_mkdocs
        ;;
      r|1)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_systemctl_one_service
        ;;
      d|2)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_quick_deploy
        ;;
      s|3)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        _interactive_show_status
        ;;
      o)
        if [[ "${BIFROST_SSH_LAST_OUTPUT_FULL:-0}" == "1" ]]; then
          BIFROST_SSH_LAST_OUTPUT_FULL=0
        else
          BIFROST_SSH_LAST_OUTPUT_FULL=1
        fi
        ;;
      v)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        if [[ -f "${BIFROST_PERSIST_DEPLOY_LOG}" ]] && [[ -s "${BIFROST_PERSIST_DEPLOY_LOG}" ]]; then
          if command -v less >/dev/null 2>&1; then
            less -R -F "${BIFROST_PERSIST_DEPLOY_LOG}" || true
          else
            cat "${BIFROST_PERSIST_DEPLOY_LOG}"
          fi
        else
          echo "[INFO] No deploy log saved yet. Run Deploy (menu d or 2) first." >"${BIFROST_SSH_LAST_LOG}"
        fi
        ;;
      q|quit)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[INFO] Bye." >"${BIFROST_SSH_LAST_LOG}"
        _interactive_paint_full
        break
        ;;
      8)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[WARN] systemd install is now menu tl1 (not 8)." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      4|5|6|7|9)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[WARN] Main menu no longer uses these number keys — use r/1 d/2 s/3 db1 db2 tl1–tl6 o v q (see menu above)." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      l)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[INFO] Local Mac scan is now tl4 (not l)." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      p)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[INFO] Remote Prod scan is now tl5 (not p)." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      m)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[INFO] MkDocs deploy is now tl6 (not m)." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      *)
        BIFROST_SSH_LAST_OUTPUT_LINES=""
        echo "[WARN] Unknown choice — try r/1 d/2 s/3 db1 db2 tl1 tl2 tl3 tl4 tl5 tl6 o v q. (db*=database · tl1=systemd/nginx · tl6=MkDocs · o=full Last output · v=deploy log)" >"${BIFROST_SSH_LAST_LOG}"
        ;;
    esac
  done
  _ssh_control_cleanup
  [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]] && rm -f "${BIFROST_SSH_LAST_LOG}"
  BIFROST_SSH_TUI=0
  BIFROST_SSH_LAST_LOG=""
  trap - EXIT INT TERM
}

# --- argument parsing ---

INTERACTIVE_MODE=0
CLI_ARGS=()
PRESET_SUDO_PASSWORD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -i|--interactive)
      INTERACTIVE_MODE=1
      shift
      ;;
    --password=*)
      PRESET_SUDO_PASSWORD="${1#*=}"
      shift
      ;;
    --password|-p)
      if [[ $# -lt 2 ]]; then
        usage_error "${1} requires a value"
      fi
      PRESET_SUDO_PASSWORD="$2"
      shift 2
      ;;
    *)
      CLI_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -n "${PRESET_SUDO_PASSWORD}" ]]; then
  SUDO_PASSWORD="${PRESET_SUDO_PASSWORD//$'\r'/}"
elif [[ -n "${DEPLOY_SUDO_PASSWORD:-}" ]]; then
  SUDO_PASSWORD="${DEPLOY_SUDO_PASSWORD//$'\r'/}"
fi
# Persist for menu actions (restore uses BIFROST_SESSION_SUDO_PASSWORD before every remote sudo).
if [[ -n "${SUDO_PASSWORD}" ]]; then
  BIFROST_SESSION_SUDO_PASSWORD="${SUDO_PASSWORD}"
fi

if [[ "${INTERACTIVE_MODE}" == "1" ]] || [[ ${#CLI_ARGS[@]} -eq 0 ]]; then
  interactive_mode
  exit 0
fi

set -- "${CLI_ARGS[@]}"

CLI_DB_REFRESH=0
CLI_DB_REFRESH_DEV=0
CLI_DB_REL_DRY=0
CLI_DB_REL_DRY_DEV=0
CLI_DB_REL_YES=0
CLI_DB_REL_YES_DEV=0
CLI_LOCAL_MAC_SERVICES=0
CLI_REMOTE_SERVICES_STATUS=0
CLI_INSTALL_SYSTEMD=0
CLI_SHOW_LAST_DEPLOY=0
CLI_DEPLOY_MKDOCS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --show-last-deploy) CLI_SHOW_LAST_DEPLOY=1 ;;
    --deploy-mkdocs) CLI_DEPLOY_MKDOCS=1 ;;
    --db-refresh) CLI_DB_REFRESH=1 ;;
    --db-refresh-dev) CLI_DB_REFRESH_DEV=1 ;;
    --db-release-locks)
      CLI_DB_REL_DRY=1
      ;;
    --db-release-locks-dev) CLI_DB_REL_DRY_DEV=1 ;;
    --db-release-locks-terminate) CLI_DB_REL_YES=1 ;;
    --db-release-locks-terminate-dev) CLI_DB_REL_YES_DEV=1 ;;
    --local-mac-services) CLI_LOCAL_MAC_SERVICES=1 ;;
    --remote-services-status) CLI_REMOTE_SERVICES_STATUS=1 ;;
    --install-systemd-units) CLI_INSTALL_SYSTEMD=1 ;;
    --server|-server) _restart_add_unit bifrost-server ;;
    --engine|-engine)
      usage_error "bifrost-engine is not controlled by bifrost_ssh.sh; use Ops UI (Daemon / market-ingest) like Socket Services."
      ;;
    --massive|-massive) _restart_add_unit bifrost-massive ;;
    --docs|-docs) _restart_add_unit bifrost-docs ;;
    --ops|-ops) _restart_add_unit bifrost-ops ;;
    --trading|-trading) _restart_add_unit bifrost-trading ;;
    --strategy|-strategy) _restart_add_unit bifrost-strategy ;;
    --portfolio|-portfolio) _restart_add_unit bifrost-portfolio ;;
    --market|-market) _restart_add_unit bifrost-market ;;
    --agent|-agent) _restart_add_unit bifrost-agent ;;
    --bifrost-research) _restart_add_unit bifrost-research ;;
    --all|-all)
      if [[ -n "${RESTART_CATEGORY}" ]]; then
        usage_error "cannot combine --all with --architecture/--account/--research/--feed."
      fi
      RESTART_ALL=1
      ;;
    --apis|-apis)
      if [[ -n "${RESTART_CATEGORY}" ]]; then
        usage_error "cannot combine --apis with --architecture/--account/--research/--feed."
      fi
      RESTART_ALL_APIS=1
      ;;
    --all-stack|-all-stack)
      if [[ -n "${RESTART_CATEGORY}" ]]; then
        usage_error "cannot combine --all-stack with --architecture/--account/--research/--feed."
      fi
      RESTART_ALL_STACK=1
      ;;
    --architecture) _pick_category_flag architecture ;;
    --account) _pick_category_flag account ;;
    --research) _pick_category_flag research ;;
    --feed) _pick_category_flag feed ;;
    --stop|-stop) _set_action stop ;;
    --start|-start) _set_action start ;;
    --restart|-restart) _set_action restart ;;
    --status|-status) DO_STATUS=1 ;;
    --deploy|-deploy) DO_DEPLOY=1 ;;
    --deploy-only) DO_DEPLOY_ONLY=1 ;;
    --migrate) DO_MIGRATE=1 ;;
    --sync-prod-config) SYNC_PROD_CONFIG=1 ;;
    --password=*)
      SUDO_PASSWORD="${1#*=}"
      SUDO_PASSWORD="${SUDO_PASSWORD//$'\r'/}"
      shift
      continue
      ;;
    --password|-p)
      if [[ $# -lt 2 ]]; then
        usage_error "${1} requires a value"
      fi
      SUDO_PASSWORD="${2//$'\r'/}"
      shift 2
      continue
      ;;
    *)
      usage_error "unknown option: $1"
      ;;
  esac
  shift || true
done

if [[ "${CLI_SHOW_LAST_DEPLOY}" == "1" ]] && [[ "${CLI_DEPLOY_MKDOCS}" == "1" ]]; then
  usage_error "cannot combine --show-last-deploy with --deploy-mkdocs."
fi

# View last deploy log (no SSH; local file only).
if [[ "${CLI_SHOW_LAST_DEPLOY}" == "1" ]]; then
  if [[ -f "${BIFROST_PERSIST_DEPLOY_LOG}" ]] && [[ -s "${BIFROST_PERSIST_DEPLOY_LOG}" ]]; then
    _msg_info "Last deploy log: ${BIFROST_PERSIST_DEPLOY_LOG}"
    if command -v less >/dev/null 2>&1; then
      less -R -F "${BIFROST_PERSIST_DEPLOY_LOG}"
    else
      cat "${BIFROST_PERSIST_DEPLOY_LOG}"
    fi
  else
    _msg_warn "No deploy log found at ${BIFROST_PERSIST_DEPLOY_LOG}. Run a deploy first."
    exit 1
  fi
  exit 0
fi

# DB-only: schema refresh or lock release (local or remote; no rsync / systemctl).
_db_cli_count=$((CLI_DB_REFRESH + CLI_DB_REFRESH_DEV + CLI_DB_REL_DRY + CLI_DB_REL_DRY_DEV + CLI_DB_REL_YES + CLI_DB_REL_YES_DEV))
if [[ "${CLI_LOCAL_MAC_SERVICES}" == "1" ]] && [[ "${CLI_REMOTE_SERVICES_STATUS}" == "1" ]]; then
  usage_error "use only one of --local-mac-services or --remote-services-status."
fi
if [[ "${_db_cli_count}" -gt 0 ]]; then
  if [[ "${CLI_LOCAL_MAC_SERVICES}" == "1" ]] || [[ "${CLI_REMOTE_SERVICES_STATUS}" == "1" ]]; then
    usage_error "cannot combine --db-* with --local-mac-services or --remote-services-status."
  fi
  if [[ "${_db_cli_count}" -gt 1 ]]; then
    usage_error "use only one of --db-refresh / --db-refresh-dev / --db-release-locks / --db-release-locks-dev / --db-release-locks-terminate / --db-release-locks-terminate-dev."
  fi
  if [[ "${DO_DEPLOY}" == "1" ]] || [[ "${DO_DEPLOY_ONLY}" == "1" ]] || [[ -n "${ACTION:-}" ]] || [[ "${DO_STATUS}" == "1" ]] \
    || [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]] || [[ "${DO_MIGRATE}" == "1" ]] || [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
    usage_error "DB flags (--db-refresh*) cannot be combined with deploy, systemctl, --migrate, or --sync-prod-config."
  fi
  if [[ "${CLI_DB_REFRESH_DEV}" == "1" ]]; then
    _cli_local_db_refresh_schema
    exit $?
  fi
  if [[ "${CLI_DB_REFRESH}" == "1" ]]; then
    _cli_remote_db_refresh_schema
    exit $?
  fi
  if [[ "${CLI_DB_REL_DRY_DEV}" == "1" ]]; then
    _cli_local_db_release_locks
    exit $?
  fi
  if [[ "${CLI_DB_REL_DRY}" == "1" ]]; then
    _cli_remote_db_release_locks
    exit $?
  fi
  if [[ "${CLI_DB_REL_YES_DEV}" == "1" ]]; then
    _cli_local_db_release_locks --yes
    exit $?
  fi
  if [[ "${CLI_DB_REL_YES}" == "1" ]]; then
    _cli_remote_db_release_locks --yes
    exit $?
  fi
fi

# Install systemd units only (remote sudo cp + daemon-reload).
if [[ "${CLI_INSTALL_SYSTEMD}" == "1" ]]; then
  if [[ "${_db_cli_count}" -gt 0 ]] || [[ "${CLI_LOCAL_MAC_SERVICES}" == "1" ]] || [[ "${CLI_REMOTE_SERVICES_STATUS}" == "1" ]]; then
    usage_error "--install-systemd-units cannot be combined with --db-*, --local-mac-services, or --remote-services-status."
  fi
  if [[ "${DO_DEPLOY}" == "1" ]] || [[ "${DO_DEPLOY_ONLY}" == "1" ]] || [[ -n "${ACTION:-}" ]] || [[ "${DO_STATUS}" == "1" ]] \
    || [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]] || [[ "${DO_MIGRATE}" == "1" ]] || [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
    usage_error "--install-systemd-units cannot be combined with deploy, systemctl, --migrate, or --sync-prod-config."
  fi
  _cli_remote_install_systemd_units
  exit $?
fi

# MkDocs static site only (mkdocs build + rsync site/; no app deps, DB, or systemctl).
if [[ "${CLI_DEPLOY_MKDOCS}" == "1" ]]; then
  if [[ "${_db_cli_count}" -gt 0 ]] || [[ "${CLI_INSTALL_SYSTEMD}" == "1" ]] || [[ "${CLI_LOCAL_MAC_SERVICES}" == "1" ]] || [[ "${CLI_REMOTE_SERVICES_STATUS}" == "1" ]]; then
    usage_error "--deploy-mkdocs cannot be combined with --db-*, --install-systemd-units, --local-mac-services, or --remote-services-status."
  fi
  if [[ "${DO_DEPLOY}" == "1" ]] || [[ "${DO_DEPLOY_ONLY}" == "1" ]] || [[ -n "${ACTION:-}" ]] || [[ "${DO_STATUS}" == "1" ]] \
    || [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]] || [[ "${DO_MIGRATE}" == "1" ]] || [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
    usage_error "--deploy-mkdocs cannot be combined with deploy, systemctl, --migrate, or --sync-prod-config."
  fi
  _cli_deploy_mkdocs
  exit $?
fi

# Local Mac only: pgrep ingest + celery (no SSH; same scripts as SubprocessLocalExecutor).
if [[ "${CLI_LOCAL_MAC_SERVICES}" == "1" ]]; then
  if [[ "${_db_cli_count}" -gt 0 ]] || [[ "${CLI_INSTALL_SYSTEMD}" == "1" ]]; then
    usage_error "--local-mac-services cannot be combined with --db-* or --install-systemd-units."
  fi
  if [[ "${DO_DEPLOY}" == "1" ]] || [[ "${DO_DEPLOY_ONLY}" == "1" ]] || [[ -n "${ACTION:-}" ]] || [[ "${DO_STATUS}" == "1" ]] \
    || [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]] || [[ "${DO_MIGRATE}" == "1" ]] || [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
    usage_error "--local-mac-services cannot be combined with deploy, systemctl, --migrate, or --sync-prod-config."
  fi
  _cli_local_mac_subprocess_check
  exit 0
fi

# Remote Linux: systemd + worker@* on DEPLOY_HOST.
if [[ "${CLI_REMOTE_SERVICES_STATUS}" == "1" ]]; then
  if [[ "${_db_cli_count}" -gt 0 ]] || [[ "${CLI_INSTALL_SYSTEMD}" == "1" ]]; then
    usage_error "--remote-services-status cannot be combined with --db-* or --install-systemd-units."
  fi
  if [[ "${DO_DEPLOY}" == "1" ]] || [[ "${DO_DEPLOY_ONLY}" == "1" ]] || [[ -n "${ACTION:-}" ]] || [[ "${DO_STATUS}" == "1" ]] \
    || [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]] || [[ "${DO_MIGRATE}" == "1" ]] || [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
    usage_error "--remote-services-status cannot be combined with deploy, systemctl, --migrate, or --sync-prod-config."
  fi
  _cli_remote_services_systemd_scan
  exit 0
fi

if [[ "${DO_DEPLOY_ONLY}" == "1" ]]; then
  if [[ "${DO_DEPLOY}" == "1" ]]; then
    usage_error "use either --deploy or --deploy-only, not both."
  fi
  if [[ -n "${ACTION}" ]]; then
    usage_error "--deploy-only cannot be combined with --stop/--start/--restart."
  fi
  if [[ "${RESTART_ALL}" == "1" ]] || [[ "${RESTART_ALL_STACK}" == "1" ]] || [[ "${RESTART_ALL_APIS}" == "1" ]] || [[ -n "${RESTART_CATEGORY}" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]]; then
    if [[ "${DO_STATUS}" != "1" ]]; then
      usage_error "--deploy-only cannot be combined with service flags (--server, …, --apis, --all, --all-stack, category) unless --status is also set."
    fi
  fi
  if [[ "${DO_STATUS}" == "1" ]]; then
    if [[ "${RESTART_ALL}" != "1" ]] && [[ "${RESTART_ALL_STACK}" != "1" ]] && [[ "${RESTART_ALL_APIS}" != "1" ]] && [[ -z "${RESTART_CATEGORY}" ]] && [[ ${#RESTART_UNITS[@]} -eq 0 ]]; then
      usage_error "--deploy-only --status requires a service flag (--server, …, --apis, --all, --all-stack, or --architecture/--account/--research/--feed)."
    fi
  fi
fi

if [[ "${RESTART_ALL}" == "1" ]] && [[ "${RESTART_ALL_STACK}" == "1" ]]; then
  usage_error "use either --all (bifrost-server only) or --all-stack (HTTP+agent+Socket Services, no Engine), not both."
fi
if [[ "${RESTART_ALL_APIS}" == "1" ]] && [[ "${RESTART_ALL_STACK}" == "1" ]]; then
  usage_error "use either --apis (HTTP APIs only) or --all-stack (full stack), not both."
fi
if [[ "${RESTART_ALL_APIS}" == "1" ]] && [[ "${RESTART_ALL}" == "1" ]]; then
  usage_error "use either --apis or --all (bifrost-server only), not both."
fi

if [[ "${RESTART_ALL_STACK}" == "1" ]]; then
  RESTART_UNITS=("${BIFROST_FULL_STACK_UNITS[@]}")
elif [[ "${RESTART_ALL_APIS}" == "1" ]]; then
  RESTART_UNITS=("${BIFROST_HTTP_UNITS[@]}")
elif [[ "${RESTART_ALL}" == "1" ]]; then
  RESTART_UNITS=(bifrost-server)
fi

if [[ "${DO_DEPLOY_ONLY}" != "1" ]]; then
  if [[ -z "${ACTION}" && "${DO_STATUS}" != "1" ]]; then
    usage_error "missing action: specify --stop, --start, or --restart, or use --status, or --deploy-only."
  fi
  if [[ "${DO_DEPLOY}" == "1" && -z "${ACTION}" ]]; then
    usage_error "--deploy requires --stop, --start, or --restart."
  fi
  if [[ -n "${ACTION}" || "${DO_STATUS}" == "1" ]]; then
    if [[ "${RESTART_ALL}" != "1" ]] && [[ "${RESTART_ALL_STACK}" != "1" ]] && [[ "${RESTART_ALL_APIS}" != "1" ]] && [[ -z "${RESTART_CATEGORY}" ]] && [[ ${#RESTART_UNITS[@]} -eq 0 ]]; then
      usage_error "missing service: specify at least one of --server, --massive, --docs, --ops, --trading, --strategy, --portfolio, --market, --bifrost-research, --agent, --all, --apis, --all-stack, or --architecture/--account/--research/--feed. (bifrost-engine: use Dashboard.)"
    fi
  fi
fi

if [[ "${DO_MIGRATE}" == "1" ]]; then
  if [[ "${DO_DEPLOY}" != "1" && "${DO_DEPLOY_ONLY}" != "1" ]]; then
    usage_error "--migrate requires --deploy or --deploy-only."
  fi
fi

if [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
  if [[ "${DO_DEPLOY}" != "1" && "${DO_DEPLOY_ONLY}" != "1" ]]; then
    usage_error "--sync-prod-config requires --deploy or --deploy-only."
  fi
fi

_run_pipeline
exit $?
