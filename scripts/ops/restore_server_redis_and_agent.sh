#!/usr/bin/env bash
# Restore Docker Redis on the Linux app host and restart Local Control Agent (Ops executor_mode=agent).
#
# Run on the server (e.g. vision@server-app-ubt):
#   cd ~/bifrost-trader-engine && bash scripts/ops/restore_server_redis_and_agent.sh
#
# From your Mac:
#   ssh vision@192.168.10.70 'cd ~/bifrost-trader-engine && bash scripts/ops/restore_server_redis_and_agent.sh'
#
# After Redis is up: start Celery workers on Mac and/or Linux with the same merged config
# (same redis.host / broker) so they share queues — e.g.:
#   python scripts/systemd/run_celery.py --instance options_massive-1
# See config/config.yaml ops.worker_profiles and deploy/ROLLOUT_RUNBOOK.md.

set -euo pipefail

REDIS_CONTAINER_NAME="${REDIS_CONTAINER_NAME:-redis}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found in PATH" >&2
  exit 1
fi

if ! docker ps -a --format '{{.Names}}' | grep -qx "${REDIS_CONTAINER_NAME}"; then
  echo "error: no Docker container named '${REDIS_CONTAINER_NAME}'." >&2
  echo "Create one (example):" >&2
  echo "  docker run -d --name redis -p 6379:6379 redis:7" >&2
  exit 1
fi

echo "Starting Docker container '${REDIS_CONTAINER_NAME}'..."
docker start "${REDIS_CONTAINER_NAME}"
docker ps --filter "name=^${REDIS_CONTAINER_NAME}\$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
    echo "redis-cli ping: PONG"
  else
    echo "warning: redis-cli ping failed (Redis may still be starting)" >&2
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat bifrost-agent.service >/dev/null 2>&1; then
    echo "Restarting bifrost-agent.service ..."
    sudo systemctl restart bifrost-agent.service
    sudo systemctl --no-pager -l status bifrost-agent.service || true
  else
    echo "note: bifrost-agent.service not found (skip). Install from deploy/systemd/ — see deploy/ROLLOUT_RUNBOOK.md"
  fi
else
  echo "note: systemctl not found (skip bifrost-agent restart)"
fi

echo "Done. Ensure Ops API / workers use config that points redis.host to this host (Prod: 127.0.0.1, Dev Mac: server LAN IP)."
