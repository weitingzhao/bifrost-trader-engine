#!/usr/bin/env bash
# Bifrost frontend: single entry for dev / build (run from project root).
# Stack: Next.js App Router (dev: next dev; prod preview: next start after build).
#
# Usage:
#   ./scripts/run_frontend.sh dev     # Dev: 0.0.0.0, port from config/config.yaml frontend.port (default 5173); frees port first
#   ./scripts/run_frontend.sh build   # next build (output under frontend/.next)
#   ./scripts/run_frontend.sh start   # next start — run after build; same host/port as dev
#   ./scripts/run_frontend.sh install # npm install only
#
# Local UI: open http://127.0.0.1:<frontend.port>/ (rewrites in next.config.mjs proxy APIs in NODE_ENV=development).
# Monitor can still embed or reverse-proxy this origin per your ops layout.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
CONFIG_FILE="$PROJECT_ROOT/config/config.yaml"

# Read frontend.port from config/config.yaml, default 5173
get_frontend_port() {
  local py
  if [[ -x "$PROJECT_ROOT/.venv/bin/python" ]]; then
    py="$PROJECT_ROOT/.venv/bin/python"
  else
    py="python3"
  fi
  "$py" -c "
import sys
sys.path.insert(0, '$PROJECT_ROOT')
try:
    import yaml
except ImportError:
    print(5173)
    sys.exit(0)
p = '$CONFIG_FILE'
import os
if not os.path.isfile(p):
    print(5173)
    sys.exit(0)
with open(p, encoding='utf-8') as f:
    c = yaml.safe_load(f) or {}
print(c.get('frontend', {}).get('port', 5173))
" 2>/dev/null || echo "5173"
}

# Kill process(es) using the given port (macOS/Linux: lsof)
kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -i ":$port" -t 2>/dev/null) || true
  if [[ -n "$pids" ]]; then
    echo "Killing process(es) on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

cmd="${1:-}"
case "$cmd" in
  dev)
    FRONTEND_PORT=$(get_frontend_port)
    echo "Frontend dev port: $FRONTEND_PORT (from config/config.yaml frontend.port), listening on 0.0.0.0"
    kill_port "$FRONTEND_PORT"
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "node_modules not found, running npm install..."
      npm install
    fi
    exec npx next dev -H 0.0.0.0 -p "$FRONTEND_PORT"
    ;;
  build)
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "node_modules not found, running npm install..."
      npm install
    fi
    npm run build
    echo "Build complete: Next output in $FRONTEND_DIR/.next (use '$0 start' to run production server)"
    ;;
  start)
    FRONTEND_PORT=$(get_frontend_port)
    echo "Frontend production server: 0.0.0.0:$FRONTEND_PORT (run ./scripts/run_frontend.sh build first)"
    kill_port "$FRONTEND_PORT"
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "node_modules not found, running npm install..."
      npm install
    fi
    exec npx next start -H 0.0.0.0 -p "$FRONTEND_PORT"
    ;;
  install)
    cd "$FRONTEND_DIR"
    npm install
    echo "Dependencies installed."
    ;;
  *)
    echo "Usage: $0 <dev|build|start|install>"
    echo ""
    echo "  dev     - next dev on 0.0.0.0, port from config/config.yaml frontend.port (default 5173)"
    echo "  build   - next build → .next/"
    echo "  start   - next start on 0.0.0.0 (after build)"
    echo "  install - npm install in frontend/"
    exit 1
    ;;
esac
