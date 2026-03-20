#!/usr/bin/env bash
# Legacy entrypoint — forwards to bifrost_ssh.sh. Prefer: ./scripts/bifrost_ssh.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bifrost_ssh.sh" "$@"
