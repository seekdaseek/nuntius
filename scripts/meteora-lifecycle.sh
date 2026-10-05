#!/usr/bin/env bash
# The subscription-launch lifecycle on Meteora's programs as deployed on mainnet, in one command:
#
#   npm --prefix server run test:meteora
#
# Starts a local validator with the Subscriptions program (built from its release commit) and
# Meteora's DBC and DAMM v2 programs cloned from mainnet (scripts/localnet.sh --meteora), runs
# server/src/meteora-lifecycle.localnet.test.ts against it, writes the run's signatures,
# compute units, sizes and balances to evidence/meteora-localnet-results.json, and stops the
# validator. Port 8899 must be free.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
RPC="http://127.0.0.1:8899"
OUT="${METEORA_RESULTS:-$REPO/evidence/meteora-localnet-results.json}"
LOG="${NUNTIUS_LOCALNET:-$HOME/.cache/nuntius-localnet}/meteora-validator.log"
mkdir -p "$(dirname "$OUT")" "$(dirname "$LOG")"

rpc() { curl -s -m 3 "$RPC" -X POST -H 'content-type: application/json' -d "$1" 2>/dev/null || true; }
if [ -n "$(rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}')" ]; then
  echo "port 8899 already answers: stop that validator first" >&2
  exit 1
fi

bash "$HERE/localnet.sh" --meteora >"$LOG" 2>&1 &
VALIDATOR=$!
trap 'kill "$VALIDATOR" 2>/dev/null || true; wait "$VALIDATOR" 2>/dev/null || true' EXIT
echo "validator starting (log: $LOG)"
for _ in $(seq 1 120); do
  case "$(rpc '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",{"encoding":"base64","dataSlice":{"offset":0,"length":0}}]}')" in
    *'"executable":true'*) break ;;
  esac
  kill -0 "$VALIDATOR" 2>/dev/null || { tail -n 20 "$LOG" >&2; exit 1; }
  sleep 2
done
echo "validator up with DBC, DAMM v2 and Metaplex cloned from mainnet"

cd "$REPO/server"
npm run build >/dev/null
LOCALNET_RPC="$RPC" LOCALNET_METEORA=1 METEORA_RESULTS="$OUT" \
  node --test --test-reporter=spec dist/meteora-lifecycle.localnet.test.js 2>&1 |
  grep -v -E 'punycode|bigint: Failed to load|trace-deprecation'
code="${PIPESTATUS[0]}"
[ "$code" = 0 ] && echo "results: $OUT"
exit "$code"
