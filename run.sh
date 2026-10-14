#!/usr/bin/env bash
#
# notion-bulk-9router quick runner.
#
#   ./run.sh create --count 3
#   ./run.sh serve
#   ./run.sh connect --router https://9router.com
#
# Browser connection (pick one):
#   BU_CDP_WS       Browser Use cloud websocket (auto-provisioned in this env)
#   NOTION_CDP_URL  local Chrome DevTools http endpoint (e.g. http://127.0.0.1:9222)
#
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "serve" ]]; then
  ADAPTER_PORT="${ADAPTER_PORT:-8790}" exec node src/cli.js serve
fi

exec node src/cli.js "$@"
