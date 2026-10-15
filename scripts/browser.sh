#!/usr/bin/env bash
#
# Launch a local Chromium with a remote-debugging port so the toolkit can drive
# it over CDP.
#
#   scripts/browser.sh
#   CHROME=/path/to/chrome scripts/browser.sh
#   PROXY=socks5://user:pass@host:port scripts/browser.sh   # residential exit
#
# Why a proxy: 22.do (and most disposable-inbox sites) sit behind Cloudflare and
# refuse datacenter IPs. If your VPS IP is blocked, point Chromium at a
# residential proxy you control. Chromium does not accept SOCKS5 credentials on
# the command line, so for authenticated SOCKS5 use scripts/socks-relay.sh to
# expose a local unauthenticated port and pass that to PROXY.
#
# Env:
#   CHROME   path to a Chrome/Chromium binary (default: autodetect)
#   PORT     debug port (default 9222)
#   PROFILE  user-data-dir (default ./.bcode/chrome-profile)
#   PROXY    e.g. http://host:port or socks5://host:port (no auth) — optional
#   HEADLESS set to 0 to run with a window (needs a display)
#
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for c in chromium chromium-browser google-chrome google-chrome-stable chrome; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
  done
fi
if [[ -z "$CHROME" ]]; then
  echo "No Chrome/Chromium found. Set CHROME=/path/to/chrome." >&2
  exit 1
fi

PORT="${PORT:-9222}"
PROFILE="${PROFILE:-$PWD/.bcode/chrome-profile}"
mkdir -p "$PROFILE"

ARGS=(
  --remote-debugging-port="$PORT"
  --remote-allow-origins=*
  --user-data-dir="$PROFILE"
  --no-first-run --no-default-browser-check
  --window-size=1366,900
  --disable-blink-features=AutomationControlled
  --disable-dev-shm-usage
)
[[ "${HEADLESS:-1}" == "1" ]] && ARGS+=(--headless=new)
[[ -n "${PROXY:-}" ]] && ARGS+=(--proxy-server="$PROXY")
[[ "${NO_SANDBOX:-0}" == "1" ]] && ARGS+=(--no-sandbox)

echo "chromium: $CHROME"
echo "debug:    http://127.0.0.1:$PORT"
echo "profile:  $PROFILE"
[[ -n "${PROXY:-}" ]] && echo "proxy:    $PROXY"

exec "$CHROME" "${ARGS[@]}" about:blank
