#!/usr/bin/env bash
# The web backing page clicked through in a headless browser, against the real server and
# executor on a local validator with Meteora's programs cloned from mainnet:
#
#   bash scripts/backing-page-e2e.sh
#
# CHROMIUM_PATH names the browser (Playwright's headless shell by default); SHOTS_DIR, if set,
# receives a screenshot of each step. Port 8899 must be free.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
RPC="http://127.0.0.1:8899"
LOG="${NUNTIUS_LOCALNET:-$HOME/.cache/nuntius-localnet}/backing-page-validator.log"
mkdir -p "$(dirname "$LOG")"
if [ -z "${CHROMIUM_PATH:-}" ]; then
  CHROMIUM_PATH="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -n 1 || true)"
fi
export CHROMIUM_PATH

rpc() { curl -s -m 3 "$RPC" -X POST -H 'content-type: application/json' -d "$1" 2>/dev/null || true; }
[ -z "$(rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}')" ] || { echo "port 8899 already answers: stop that validator first" >&2; exit 1; }
bash "$HERE/localnet.sh" --meteora >"$LOG" 2>&1 &
VALIDATOR=$!
trap 'kill "$VALIDATOR" 2>/dev/null || true; wait "$VALIDATOR" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  case "$(rpc '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",{"encoding":"base64","dataSlice":{"offset":0,"length":0}}]}')" in
    *'"executable":true'*) break ;;
  esac
  kill -0 "$VALIDATOR" 2>/dev/null || { tail -n 20 "$LOG" >&2; exit 1; }
  sleep 2
done
(cd "$REPO/web" && node build.mjs >/dev/null)
(cd "$REPO/server" && npm run build >/dev/null)
cd "$REPO/server"
LOCALNET_RPC="$RPC" LOCALNET_METEORA=1 node --test --test-concurrency=1 --test-reporter=spec test-web/backing-page.localnet.mjs 2>&1 |
  grep --line-buffered -v -E 'punycode|bigint: Failed to load|trace-deprecation'
exit "${PIPESTATUS[0]}"
