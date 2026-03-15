#!/usr/bin/env bash
# Bifrost frontend: single entry for dev / build (run from project root).
#
# Usage:
#   ./scripts/run_frontend.sh dev    # Dev mode, listen 0.0.0.0, port from config/config.yaml frontend.port; kills process on port first
#   ./scripts/run_frontend.sh build  # Production build to frontend/dist
#   ./scripts/run_frontend.sh install # Install deps only (first run or after package.json change)
#
# Use dev for daily React/style work and debugging (status server on 8765).
# Use build before deploy or to serve static assets; then http://localhost:8765/ serves the React app.

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
    exec npm run dev -- --port "$FRONTEND_PORT" --host 0.0.0.0
    ;;
  build)
    cd "$FRONTEND_DIR"
    if [[ ! -d node_modules ]]; then
      echo "node_modules not found, running npm install..."
      npm install
    fi
    npm run build
    echo "Build complete: $FRONTEND_DIR/dist"
    ;;
  install)
    cd "$FRONTEND_DIR"
    npm install
    echo "Dependencies installed."
    ;;
  *)
    echo "Usage: $0 <dev|build|install>"
    echo ""
    echo "  dev     - Start dev server (0.0.0.0, port from config/config.yaml frontend.port, default 5173)"
    echo "  build   - Production build to frontend/dist for status server or static deploy"
    echo "  install - Install npm dependencies only"
    exit 1
    ;;
esac
