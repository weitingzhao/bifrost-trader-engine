#!/usr/bin/env bash
# Kill all Bifrost Socket Services (Massive WS + IB Broker Services).
#
# Usage:
#   bash scripts/kill_socket_services.sh           # stop all four services
#   bash scripts/kill_socket_services.sh --force   # SIGKILL if SIGTERM fails
#
# Run as a user with sudo rights, or as root.
# Requires systemctl to be available (Linux with systemd).

set -euo pipefail

FORCE=0
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=1
done

SERVICES=(
  bifrost-massive-ws
  bifrost-ib-ingestor
  bifrost-ib-account-agent
  bifrost-ib-operator
)

# Friendly process name fragments (for fallback pkill when systemd stop fails).
# Matches the ExecStart script names from the .service files.
PROC_PATTERNS=(
  run_massive_ws.py
  run_ib_ingestor.py
  run_ib_account_agent.py
  run_ib_operator.py
)

RED='\033[0;31m'
YEL='\033[1;33m'
GRN='\033[0;32m'
NC='\033[0m'

ok()   { echo -e "${GRN}[OK]${NC}  $*"; }
warn() { echo -e "${YEL}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; }

echo ""
echo "=== Bifrost Socket Services shutdown ==="
echo "Services: ${SERVICES[*]}"
[[ $FORCE -eq 1 ]] && echo "Mode: --force (SIGKILL fallback enabled)"
echo ""

any_failed=0

for i in "${!SERVICES[@]}"; do
  svc="${SERVICES[$i]}"
  pat="${PROC_PATTERNS[$i]}"

  echo -n "  Stopping ${svc} ... "

  # Check if unit is known to systemd at all.
  if ! systemctl list-unit-files --quiet "${svc}.service" &>/dev/null; then
    warn "${svc}.service not found in systemd — skipping"
    continue
  fi

  active=$(systemctl is-active "${svc}.service" 2>/dev/null || true)

  if [[ "$active" == "inactive" || "$active" == "failed" || "$active" == "dead" ]]; then
    ok "already stopped (${active})"
    continue
  fi

  # Attempt graceful stop.
  if sudo systemctl stop "${svc}.service" 2>/dev/null; then
    active_after=$(systemctl is-active "${svc}.service" 2>/dev/null || echo "unknown")
    if [[ "$active_after" == "inactive" || "$active_after" == "failed" || "$active_after" == "dead" ]]; then
      ok "stopped"
    else
      warn "systemctl stop returned 0 but unit is still '${active_after}'"
    fi
  else
    warn "systemctl stop failed for ${svc} (state: ${active})"

    if [[ $FORCE -eq 1 ]]; then
      echo -n "  SIGKILL fallback for pattern '${pat}' ... "
      pids=$(pgrep -f "$pat" 2>/dev/null || true)
      if [[ -n "$pids" ]]; then
        if kill -9 $pids 2>/dev/null; then
          ok "killed PIDs: ${pids}"
        else
          err "kill -9 failed for PIDs: ${pids}"
          any_failed=1
        fi
      else
        warn "no matching process found for '${pat}'"
      fi
    else
      err "Use --force to SIGKILL remaining processes."
      any_failed=1
    fi
  fi
done

echo ""
echo "=== Final status ==="
for svc in "${SERVICES[@]}"; do
  active=$(systemctl is-active "${svc}.service" 2>/dev/null || echo "not-found")
  printf "  %-35s %s\n" "${svc}.service" "$active"
done
echo ""

if [[ $any_failed -eq 1 ]]; then
  err "One or more services could not be stopped. Check journalctl -u <service> for details."
  exit 1
fi

ok "All Socket Services stopped."
exit 0
