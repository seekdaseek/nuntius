#!/usr/bin/env bash
# nuntius's partner configs, as created on mainnet, on a local validator, in one command:
#
#   bash scripts/partner-configs-localnet.sh
#
# Starts scripts/localnet.sh --meteora with both partner configs (SKR and USDC) and the SKR mint
# cloned from mainnet, and USDC's mint loaded from mainnet's bytes with one change: a mint
# authority generated here, so the test's backer can hold USDC. Then runs
# server/src/partner-configs.localnet.test.ts against it (a launch on each config through
# /api/launch/create, and a USDC backing end to end) and stops the validator. Port 8899 must be free.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
RPC="http://127.0.0.1:8899"
ROOT="${NUNTIUS_LOCALNET:-$HOME/.cache/nuntius-localnet}"
LOG="$ROOT/partner-configs-validator.log"
CLONE_RPC="${CLONE_RPC:-https://api.mainnet-beta.solana.com}"
SKR_CONFIG="DdiaEHahNnz41GHh2AHCsZqGuuoW1A1nnjDKFN8bYM3d"
USDC_CONFIG="HyT5SubGeApBbRce3KQdkaPJv8K4yFHSg7bLrtu15eSk"
SKR_MINT="SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
mkdir -p "$ROOT"

rpc() { curl -s -m 3 "$RPC" -X POST -H 'content-type: application/json' -d "$1" 2>/dev/null || true; }
if [ -n "$(rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}')" ]; then
  echo "port 8899 already answers: stop that validator first" >&2
  exit 1
fi

# The CLI that localnet.sh fetched (it fetches it on its first run).
SOLANA="$ROOT/solana-release/bin/solana"
KEYGEN="$ROOT/solana-release/bin/solana-keygen"
[ -x "$SOLANA" ] || { echo "run scripts/localnet.sh once first: it fetches the Solana CLI" >&2; exit 1; }

# USDC with a local mint authority: mainnet's mint account, bytes 4..36 (mint_authority) replaced.
AUTHORITY="$ROOT/usdc-local-mint-authority.json"
"$KEYGEN" new --no-bip39-passphrase --silent --force -o "$AUTHORITY" >/dev/null
"$SOLANA" account "$USDC_MINT" --output json --url "$CLONE_RPC" >"$ROOT/usdc-mint.mainnet.json"
# Edited as text: a JSON round trip in node turns rentEpoch (u64::MAX) into a float the validator refuses.
node -e '
  const fs = require("fs")
  const [src, key, out] = process.argv.slice(1)
  const text = fs.readFileSync(src, "utf8")
  const b64 = JSON.parse(text).account.data[0]
  const data = Buffer.from(b64, "base64")
  if (data.length !== 82 || data.readUInt32LE(0) !== 1) throw new Error("not a mint with an authority")
  data.set(Uint8Array.from(JSON.parse(fs.readFileSync(key, "utf8"))).subarray(32, 64), 4)
  if (text.split(b64).length !== 2) throw new Error("the mint data is not in the dump exactly once")
  fs.writeFileSync(out, text.replace(b64, data.toString("base64")))
' "$ROOT/usdc-mint.mainnet.json" "$AUTHORITY" "$ROOT/usdc-mint.local.json"

bash "$HERE/localnet.sh" --meteora \
  --clone "$SKR_CONFIG" --clone "$USDC_CONFIG" --clone "$SKR_MINT" \
  --account "$USDC_MINT" "$ROOT/usdc-mint.local.json" >"$LOG" 2>&1 &
VALIDATOR=$!
trap 'kill "$VALIDATOR" 2>/dev/null || true; wait "$VALIDATOR" 2>/dev/null || true' EXIT
echo "validator starting (log: $LOG)"
for _ in $(seq 1 120); do
  case "$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$USDC_CONFIG\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}")" in
    *'"owner":"dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"'*) break ;;
  esac
  kill -0 "$VALIDATOR" 2>/dev/null || { tail -n 20 "$LOG" >&2; exit 1; }
  sleep 2
done
echo "validator up: DBC, DAMM v2, Metaplex, both partner configs, SKR, and USDC with a local mint authority"

cd "$REPO/server"
npm run build >/dev/null
LOCALNET_RPC="$RPC" LOCALNET_PARTNER_CONFIGS=1 LOCALNET_USDC_AUTHORITY="$AUTHORITY" \
  node --test --test-concurrency=1 --test-reporter=spec dist/partner-configs.localnet.test.js 2>&1 |
  grep -v -E 'punycode|bigint: Failed to load|trace-deprecation'
exit "${PIPESTATUS[0]}"
