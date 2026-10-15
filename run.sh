#!/usr/bin/env bash
#
# notion-bulk-9router quick runner.
#
#   ./run.sh create --count 3
#   ./run.sh serve
#   ./run.sh connect --router https://9router.com
#
# Browser connection (pick one):
#   NOTION_CDP_URL  local Chrome/Chromium DevTools http endpoint (default http://127.0.0.1:9222)
#   NOTION_CDP_WS   a CDP websocket (e.g. a remote/cloud browser YOU provisioned)
#
# This project never ships or assumes any hosted-browser credential. Bring your
# own Chromium (see scripts/browser.sh) or your own CDP websocket.
#
set -euo pipefail
cd "$(dirname "$0")"

# Default to a local Chromium debug endpoint when nothing else is set.
export NOTION_CDP_URL="${NOTION_CDP_URL:-http://127.0.0.1:9222}"

if [[ "${1:-}" == "serve" ]]; then
  ADAPTER_PORT="${ADAPTER_PORT:-8790}" exec node src/cli.js serve
fi

exec node src/cli.js "$@"
