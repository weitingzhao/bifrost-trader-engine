#!/usr/bin/env bash
# Run ON THE Linux server after the repo is synced (e.g. ./scripts/bifrost_ssh.sh --deploy-only).
# Installs the sample vhost into /etc/nginx and reloads. Requires sudo.
#
# Usage (from repo root on the server):
#   bash deploy/nginx/install_on_server.sh
#
# If your deploy path is not the default in bifrost_ssh.sh, set DEPLOY_PATH or run from repo root.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF_SRC="${REPO_ROOT}/deploy/nginx/bifrost-status.conf"
if [[ ! -f "${CONF_SRC}" ]]; then
  echo "Cannot find ${CONF_SRC}; run this script from the cloned repo (deploy/nginx/install_on_server.sh)." >&2
  exit 1
fi

echo "Installing Nginx site from ${CONF_SRC}"
sudo cp "${CONF_SRC}" /etc/nginx/sites-available/bifrost-status
sudo ln -sf /etc/nginx/sites-available/bifrost-status /etc/nginx/sites-enabled/bifrost-status

if [[ -f /etc/nginx/sites-enabled/default ]]; then
  echo "Removing /etc/nginx/sites-enabled/default so port 80 is served by bifrost (avoids 404 on /status)."
  sudo rm /etc/nginx/sites-enabled/default
fi

sudo nginx -t
sudo systemctl reload nginx
echo "OK. Test: curl -sS http://127.0.0.1/status | head -c 200"
echo "If bifrost-server is down, use: sudo systemctl status bifrost-server"
