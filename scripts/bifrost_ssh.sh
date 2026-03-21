#!/usr/bin/env bash
# Sync project to a Linux host over SSH (optional), then run systemctl on selected units (optional).
#
# See usage() or: ./scripts/bifrost_ssh.sh --help
#
# Bash 3.2 (macOS) + set -u: avoid expanding empty arrays with "${arr[@]}" — use length checks first.
#
# Interactive mode (no args, or -i/--interactive): SSH ControlMaster — SSH login once (unless using keys);
# sudo password is kept in memory for the whole session (sudo -S) until quit or menu (4) Clear.

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
declare -a RESTART_UNITS=()

# Interactive full-screen TUI: menu on top, last N lines of command output below.
BIFROST_SSH_TUI=0
BIFROST_SSH_LAST_LOG=""
BIFROST_SSH_RESULT_LINES=20

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

_interactive_paint_main_menu() {
  echo "${C_BLUE}${C_BOLD}--- Main menu ---${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}1)${C_RESET} ${C_BOLD}systemctl:${C_RESET} one unit or all ${C_DIM}(units 1–3 + 4=all; e.g. engine restart, ${C_BOLD}43${C_DIM} = all+restart)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}2)${C_RESET} ${C_BOLD}Quick:${C_RESET} Deploy ${C_DIM}(1 Server / 2 Engine / 3 Celery / 4 All; append ${C_BOLD}R${C_DIM} to restart after deploy, e.g. 2R)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}3)${C_RESET} Reconnect SSH master ${C_DIM}(password again)${C_RESET}"
  echo "  ${C_GREEN}${C_BOLD}4)${C_RESET} Clear stored sudo password"
  echo "  ${C_YELLOW}${C_BOLD}q)${C_RESET} Quit"
}

# Pad with dim rows so the result area is always exactly BIFROST_SSH_RESULT_LINES lines.
_interactive_paint_result_block() {
  local _tmp _n line
  echo "${C_BLUE}${C_BOLD}── Last output (last ${BIFROST_SSH_RESULT_LINES} lines) ──${C_RESET}"
  _tmp="$(mktemp -t bifrost_ssh_tui)"
  if [[ -f "${BIFROST_SSH_LAST_LOG}" ]] && [[ -s "${BIFROST_SSH_LAST_LOG}" ]]; then
    tail -n "${BIFROST_SSH_RESULT_LINES}" "${BIFROST_SSH_LAST_LOG}" >"${_tmp}"
  else
    : >"${_tmp}"
  fi
  _n=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    _colorize_line "${line}"
    _n=$((_n + 1))
  done <"${_tmp}"
  rm -f "${_tmp}"
  while [[ ${_n} -lt ${BIFROST_SSH_RESULT_LINES} ]]; do
    echo "${C_DIM}·${C_RESET}"
    _n=$((_n + 1))
  done
}

_interactive_paint_full() {
  clear 2>/dev/null || true
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  echo "${C_BLUE}${C_BOLD}  Bifrost SSH ${C_CYAN}(interactive)${C_RESET}  ${C_DIM}${DEPLOY_USER}@${DEPLOY_HOST}  ${DEPLOY_PATH}${C_RESET}"
  echo "${C_BLUE}${C_BOLD}══════════════════════════════════════${C_RESET}"
  _interactive_paint_main_menu
  _interactive_paint_result_block
}

usage() {
  cat <<'USAGE_EOF'
bifrost_ssh.sh — SSH to the prod Linux host: optional rsync + remote build, optional systemctl on bifrost units.

Usage (from repo root):

  ./scripts/bifrost_ssh.sh
  ./scripts/bifrost_ssh.sh -i
  ./scripts/bifrost_ssh.sh --interactive
  ./scripts/bifrost_ssh.sh --password 'REMOTE_SUDO_SECRET' -i
      Interactive menu: open one SSH master (login once; kept until you quit), then run operations in a loop;
      sudo password you enter (or -p) is kept in memory for every menu action until quit or menu (4) Clear.
      Main menu stays on top; last command output is shown in the bottom 20 lines. Same flags as below.
      With --password / -p (or env DEPLOY_SUDO_PASSWORD), skip the sudo password prompt; value is
      kept in memory only for this process. Warning: --password may be visible in process listings.

  CLI (non-interactive):

  Required — pick services (one or more, or --all) AND exactly one action,
  unless you use --deploy-only:

    --server | -server          systemd unit bifrost-server
    --engine | -engine          systemd unit bifrost-engine
    --celery | -celery          systemd unit bifrost-celery
    --all | -all                all three units (server, celery, engine)

    --stop | -stop              sudo systemctl stop …
    --start | -start            sudo systemctl start …
    --restart | -restart        sudo systemctl restart …

  Optional:

    --deploy | -deploy          rsync + remote venv pip + npm build, then run systemctl if actions above are set
    --deploy-only               only rsync + remote build (no systemctl); use for first push or code-only sync

    --migrate                   with --deploy or --deploy-only: run db_refresh_schema.py --prod on remote
    --sync-prod-config          with deploy: also rsync config/config.prod.yaml (overwrites remote)

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

Examples:

  ./scripts/bifrost_ssh.sh --deploy-only
  ./scripts/bifrost_ssh.sh -engine -restart -deploy
  ./scripts/bifrost_ssh.sh -server -celery --stop
  ./scripts/bifrost_ssh.sh --all --restart -deploy

systemctl over SSH uses ssh -t when stdin is a TTY so sudo can prompt; non-interactive needs NOPASSWD for systemctl.
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
  if [[ ${#RESTART_UNITS[@]} -eq 0 ]]; then
    RESTART_UNITS+=("$u")
    return 0
  fi
  for x in "${RESTART_UNITS[@]}"; do
    [[ "$x" == "$u" ]] && return 0
  done
  RESTART_UNITS+=("$u")
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
  ACTION=""
  RESTART_UNITS=()
}

# Re-apply sudo password from interactive session backup (defensive; keeps sudo -S working for every menu run).
_bifrost_restore_session_sudo() {
  if [[ -n "${BIFROST_SESSION_SUDO_PASSWORD:-}" ]]; then
    SUDO_PASSWORD="${BIFROST_SESSION_SUDO_PASSWORD}"
  fi
}

_run_pipeline() {
  _bifrost_restore_session_sudo
  # Uses globals: DO_DEPLOY, DO_DEPLOY_ONLY, DO_MIGRATE, SYNC_PROD_CONFIG, ACTION, RESTART_UNITS, RESTART_ALL
  local REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
  local REMOTE_URL="${REMOTE}:${DEPLOY_PATH}/"
  local DO_SYNC=0
  local DO_SYSTEMCTL=0

  if [[ "${RESTART_ALL}" == "1" ]]; then
    RESTART_UNITS=(bifrost-server bifrost-celery bifrost-engine)
  fi

  if [[ "${DO_DEPLOY_ONLY}" == "1" ]]; then
    DO_SYSTEMCTL=0
  else
    DO_SYSTEMCTL=1
  fi

  if [[ "${DO_DEPLOY}" == "1" || "${DO_DEPLOY_ONLY}" == "1" ]]; then
    DO_SYNC=1
  fi

  # Nested so we can run the same body with tee (TUI) or capture-only (non-TUI).
  _run_pipeline_inner() {
    set -e
    if [[ "${DO_SYNC}" == "1" ]]; then
      echo "Deploying ${PROJECT_ROOT} -> ${REMOTE_URL}"
      if [[ "${SYNC_PROD_CONFIG}" == "1" ]]; then
        echo "Including config/config.prod.yaml (will overwrite remote file if present)."
      else
        echo "Excluding config/config.prod.yaml (pass --sync-prod-config or DEPLOY_SYNC_PROD_CONFIG=1 to push it)."
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
        rsync -avz \
          -e "ssh -S ${SSH_CONTROL_PATH}" \
          "${RSYNC_EXCLUDES[@]}" \
          "${PROJECT_ROOT}/" \
          "${REMOTE_URL}"
      elif _use_sshpass_for_ssh; then
        SSHPASS="${SUDO_PASSWORD}" rsync -avz \
          -e "sshpass -e ssh" \
          "${RSYNC_EXCLUDES[@]}" \
          "${PROJECT_ROOT}/" \
          "${REMOTE_URL}"
      else
        rsync -avz \
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
  python scripts/db_refresh_schema.py --prod
fi
echo "Remote install/build finished."
REMOTE_EOF
    else
      echo "Skipping rsync / remote build."
    fi

    if [[ "${DO_SYSTEMCTL}" == "1" ]]; then
      _units_str="${RESTART_UNITS[*]}"
      echo "Running: sudo systemctl ${ACTION} ${_units_str}"
      if [[ -n "${SUDO_PASSWORD}" ]]; then
        printf '%s\n' "${SUDO_PASSWORD}" | ssh_remote "${REMOTE}" "sudo -S systemctl ${ACTION} ${_units_str}"
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
  }

  local _log _ec
  _log="$(mktemp -t bifrost_ssh_run)"
  set +e
  if [[ "${BIFROST_SSH_TUI:-0}" == "1" ]] && [[ -n "${BIFROST_SSH_LAST_LOG:-}" ]]; then
    _msg_info "Running on remote — output streams below (SSH/sudo may take a while; sudo may prompt for password)."
    echo ""
    # Use process substitution so _run_pipeline_inner runs in the current shell, not a pipeline subshell.
    # Otherwise ssh -tt + sudo interactive password can misbehave or re-prompt.
    _run_pipeline_inner > >(tee "${BIFROST_SSH_LAST_LOG}") 2>&1
    _ec=$?
    {
      echo ""
      echo "--- exit code: ${_ec} ---"
    } >>"${BIFROST_SSH_LAST_LOG}"
    _msg_info "Remote step finished (exit ${_ec}). Redrawing menu…"
  else
    _run_pipeline_inner >"${_log}" 2>&1
    _ec=$?
    _show_result "Command output (exit ${_ec})" < "${_log}"
  fi
  set -e
  rm -f "${_log}"
  return "${_ec}"
}

# Interactive: rsync + remote build; optional systemctl restart for selected unit(s). Input: 1–4, optional trailing R.
_interactive_quick_deploy() {
  local _raw _norm _digit _want_r
  echo ""
  echo "${C_BLUE}${C_BOLD}--- Quick: Deploy ---${C_RESET}"
  _msg_info "Remote: rsync + venv pip + npm build. Append R to restart after deploy."
  echo "  ${C_GREEN}1${C_RESET} = bifrost-server   ${C_GREEN}2${C_RESET} = bifrost-engine   ${C_GREEN}3${C_RESET} = bifrost-celery   ${C_GREEN}4${C_RESET} = all three"
  echo "  Examples: ${C_DIM}4${C_RESET} = deploy only · ${C_DIM}2R${C_RESET} or ${C_DIM}2 r${C_RESET} = deploy + restart engine"
  echo "  ${C_DIM}0 = cancel${C_RESET}"
  while true; do
    echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Choice ${C_DIM}[1-4, optional R]${C_RESET} "
    read -r _raw
    _raw=$(echo "${_raw}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [[ -z "${_raw}" || "${_raw}" == "0" ]]; then
      _msg_info "Cancelled."
      return 0
    fi
    _norm=$(echo "${_raw}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [[ ! "${_norm}" =~ ^([1-4])(r)?$ ]]; then
      _msg_warn "Invalid — enter 1–4, optionally with R (e.g. 2R). Or 0 to cancel."
      continue
    fi
    _digit="${BASH_REMATCH[1]}"
    _want_r="${BASH_REMATCH[2]}"
    _reset_run_state
    if [[ -n "${_want_r}" ]]; then
      DO_DEPLOY=1
      ACTION=restart
      case "${_digit}" in
        1) _restart_add_unit bifrost-server ;;
        2) _restart_add_unit bifrost-engine ;;
        3) _restart_add_unit bifrost-celery ;;
        4) RESTART_ALL=1 ;;
      esac
      echo "${C_CYAN}→ deploy + sudo systemctl restart …${C_RESET}"
    else
      DO_DEPLOY_ONLY=1
      echo "${C_CYAN}→ deploy only (rsync + build, no systemctl)${C_RESET}"
    fi
    _run_pipeline || true
    break
  done
}

# Map token -> bifrost unit name, or ALL for all three units (empty if unknown).
_interactive_map_unit_token() {
  case "$1" in
    1|server|s|bifrost-server) echo bifrost-server ;;
    2|engine|e|bifrost-engine) echo bifrost-engine ;;
    3|celery|c|bifrost-celery) echo bifrost-celery ;;
    4|all|a) echo ALL ;;
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

# Interactive: systemctl on one bifrost-* unit or all (same action) — "<unit> <action>" or digit shorthand (unit 1–4, action 1–3).
_interactive_systemctl_one_service() {
  local _unit _act _t1 _t2 _u _a
  echo ""
  echo "${C_BLUE}${C_BOLD}--- systemctl (one unit or all) ---${C_RESET}"
  _msg_info "Enter unit + action on one line (examples below)."
  echo "  ${C_GREEN}Units:${C_RESET}  ${C_DIM}1|server|s${C_RESET} → bifrost-server  ${C_DIM}2|engine|e${C_RESET} → engine  ${C_DIM}3|celery|c${C_RESET} → celery  ${C_DIM}4|all|a${C_RESET} → all three"
  echo "  ${C_GREEN}Action:${C_RESET} ${C_DIM}1${C_RESET}=start ${C_DIM}2${C_RESET}=stop ${C_DIM}3${C_RESET}=restart"
  echo "  ${C_CYAN}Shorthand:${C_RESET} ${C_DIM}first two digits: unit ${C_BOLD}1–4${C_DIM} + action ${C_BOLD}1–3${C_RESET} (e.g. ${C_BOLD}23${C_RESET} engine+restart · ${C_BOLD}43${C_RESET} all+restart)"
  echo "  ${C_DIM}0 or empty = cancel${C_RESET}"
  while true; do
    echo -n "${C_GREEN}${C_BOLD}>${C_RESET} "
    read -r _line
    _line=$(echo "${_line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
    if [[ -z "${_line}" || "${_line}" == "0" ]]; then
      _msg_info "Cancelled."
      return 0
    fi

    # Shorthand: first digit = unit 1–4 (4=all), second = action 1–3
    _digits=$(echo "${_line}" | tr -cd '0-9')
    if [[ ${#_digits} -ge 2 ]]; then
      _d1="${_digits:0:1}"
      _d2="${_digits:1:1}"
      if [[ "${_d1}" == [1234] && "${_d2}" == [123] ]]; then
        _u="$(_interactive_map_unit_token "${_d1}")"
        _a="$(_interactive_map_action_token "${_d2}")"
        if [[ -z "${_u}" || -z "${_a}" ]]; then
          _msg_warn "Invalid shorthand — use unit 1–4 and action 1–3 (e.g. 43). Or 0 to cancel."
          continue
        fi
        if [[ "${_u}" == "ALL" ]]; then
          echo "${C_CYAN}→ sudo systemctl ${_a} bifrost-server bifrost-celery bifrost-engine${C_RESET}"
        else
          echo "${C_CYAN}→ sudo systemctl ${_a} ${_u}${C_RESET}"
        fi
        _reset_run_state
        ACTION="${_a}"
        if [[ "${_u}" == "ALL" ]]; then
          RESTART_ALL=1
        else
          _restart_add_unit "${_u}"
        fi
        _run_pipeline || true
        break
      fi
    fi

    set -- ${_line}
    if [[ $# -lt 2 ]]; then
      _msg_warn "Invalid input — use two words (engine restart, all restart) or digit shorthand (23, 43). Try again, or 0 to cancel."
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
        _msg_warn "Could not parse. Try engine restart, all restart, 2 3, or 43. Or 0 to cancel."
        continue
      fi
    fi
    if [[ "${_unit}" == "ALL" ]]; then
      echo "${C_CYAN}→ sudo systemctl ${_act} bifrost-server bifrost-celery bifrost-engine${C_RESET}"
    else
      echo "${C_CYAN}→ sudo systemctl ${_act} ${_unit}${C_RESET}"
    fi
    _reset_run_state
    ACTION="${_act}"
    if [[ "${_unit}" == "ALL" ]]; then
      RESTART_ALL=1
    else
      _restart_add_unit "${_unit}"
    fi
    _run_pipeline || true
    break
  done
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
    echo ""
    if [[ -z "${SUDO_PASSWORD}" ]]; then
      _msg_info "No sudo password stored — you will be prompted for sudo when a step runs systemctl (e.g. Quick deploy with R)."
    else
      _msg_info "sudo password kept in memory for this session (all menu actions) until you quit or choose (4) Clear."
    fi
  fi
  if [[ -n "${SUDO_PASSWORD}" ]]; then
    BIFROST_SESSION_SUDO_PASSWORD="${SUDO_PASSWORD}"
  fi

  while true; do
    _interactive_paint_full
    echo -n "${C_GREEN}${C_BOLD}[?]${C_RESET} Choice ${C_DIM}[1-4|q]${C_RESET} "
    read -r _ch
    case "${_ch}" in
      1) _interactive_systemctl_one_service ;;
      2) _interactive_quick_deploy ;;
      3)
        _msg_info "Reconnecting SSH (output streams below; may take a few seconds)…"
        echo ""
        {
          _ssh_control_cleanup
          SSH_CONTROL_PATH=""
          _ssh_control_start
        } 2>&1 | tee "${BIFROST_SSH_LAST_LOG}"
        _rc4=${PIPESTATUS[0]}
        {
          echo ""
          echo "--- exit code: ${_rc4} ---"
        } >>"${BIFROST_SSH_LAST_LOG}"
        ;;
      4)
        SUDO_PASSWORD=""
        BIFROST_SESSION_SUDO_PASSWORD=""
        echo "[INFO] Stored sudo password cleared." >"${BIFROST_SSH_LAST_LOG}"
        ;;
      q|Q)
        echo "[INFO] Bye." >"${BIFROST_SSH_LAST_LOG}"
        _interactive_paint_full
        break
        ;;
      *) echo "[WARN] Unknown choice — try 1–4 or q." >"${BIFROST_SSH_LAST_LOG}" ;;
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
  SUDO_PASSWORD="${PRESET_SUDO_PASSWORD}"
elif [[ -n "${DEPLOY_SUDO_PASSWORD:-}" ]]; then
  SUDO_PASSWORD="${DEPLOY_SUDO_PASSWORD}"
fi

if [[ "${INTERACTIVE_MODE}" == "1" ]] || [[ ${#CLI_ARGS[@]} -eq 0 ]]; then
  interactive_mode
  exit 0
fi

set -- "${CLI_ARGS[@]}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server|-server) _restart_add_unit bifrost-server ;;
    --engine|-engine) _restart_add_unit bifrost-engine ;;
    --celery|-celery) _restart_add_unit bifrost-celery ;;
    --all|-all) RESTART_ALL=1 ;;
    --stop|-stop) _set_action stop ;;
    --start|-start) _set_action start ;;
    --restart|-restart) _set_action restart ;;
    --deploy|-deploy) DO_DEPLOY=1 ;;
    --deploy-only) DO_DEPLOY_ONLY=1 ;;
    --migrate) DO_MIGRATE=1 ;;
    --sync-prod-config) SYNC_PROD_CONFIG=1 ;;
    --password=*)
      SUDO_PASSWORD="${1#*=}"
      shift
      continue
      ;;
    --password|-p)
      if [[ $# -lt 2 ]]; then
        usage_error "${1} requires a value"
      fi
      SUDO_PASSWORD="$2"
      shift 2
      continue
      ;;
    *)
      usage_error "unknown option: $1"
      ;;
  esac
  shift || true
done

if [[ "${DO_DEPLOY_ONLY}" == "1" ]]; then
  if [[ "${DO_DEPLOY}" == "1" ]]; then
    usage_error "use either --deploy or --deploy-only, not both."
  fi
  if [[ -n "${ACTION}" ]] || [[ "${RESTART_ALL}" == "1" ]] || [[ ${#RESTART_UNITS[@]} -gt 0 ]]; then
    usage_error "--deploy-only cannot be combined with --server/--engine/--celery/--all or --stop/--start/--restart."
  fi
fi

if [[ "${RESTART_ALL}" == "1" ]]; then
  RESTART_UNITS=(bifrost-server bifrost-celery bifrost-engine)
fi

if [[ "${DO_DEPLOY_ONLY}" != "1" ]]; then
  if [[ -z "${ACTION}" ]]; then
    usage_error "missing action: specify exactly one of --stop, --start, or --restart (or use --deploy-only to sync code only)."
  fi
  if [[ ${#RESTART_UNITS[@]} -eq 0 ]]; then
    usage_error "missing service: specify at least one of --server, --engine, --celery, or --all."
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
