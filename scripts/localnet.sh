#!/usr/bin/env bash
# Local validator running the Solana Subscriptions program, built from source at
# the release commit the program's own CHANGELOG says is deployed on mainnet.
#
#   scripts/localnet.sh            # fetch + build (first run), then start the validator
#   LOCALNET_RPC=http://127.0.0.1:8899 npm --prefix server test
#
# Linux x86_64 or macOS (arm64/x86_64). Needs git, curl, a Rust toolchain via rustup.
# Everything is placed under $NUNTIUS_LOCALNET (default ~/.cache/nuntius-localnet).
set -euo pipefail

AGAVE_VERSION="${AGAVE_VERSION:-v3.1.10}"
SUBS_COMMIT="${SUBS_COMMIT:-364a419}" # "ci: export single combined Squads transaction for mainnet release (#236)"
PROGRAM_ID="De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"
ROOT="${NUNTIUS_LOCALNET:-$HOME/.cache/nuntius-localnet}"
mkdir -p "$ROOT"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TRIPLE=x86_64-unknown-linux-gnu ;;
  Darwin-arm64) TRIPLE=aarch64-apple-darwin ;;
  Darwin-x86_64) TRIPLE=x86_64-apple-darwin ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [ ! -x "$ROOT/solana-release/bin/solana-test-validator" ]; then
  echo "fetching agave $AGAVE_VERSION ($TRIPLE)"
  curl -sSfL -o "$ROOT/agave.tar.bz2" \
    "https://github.com/anza-xyz/agave/releases/download/$AGAVE_VERSION/solana-release-$TRIPLE.tar.bz2"
  tar -xjf "$ROOT/agave.tar.bz2" -C "$ROOT" && rm "$ROOT/agave.tar.bz2"
fi
export PATH="$ROOT/solana-release/bin:$PATH"

SO="$ROOT/subscriptions-$SUBS_COMMIT.so"
if [ ! -f "$SO" ]; then
  if [ ! -d "$ROOT/subscriptions" ]; then
    git clone --quiet https://github.com/solana-foundation/subscriptions "$ROOT/subscriptions"
  fi
  git -C "$ROOT/subscriptions" fetch --quiet origin
  git -C "$ROOT/subscriptions" checkout --quiet "$SUBS_COMMIT"
  (cd "$ROOT/subscriptions/program" && cargo build-sbf)
  cp "$ROOT/subscriptions/target/deploy/subscriptions_program.so" "$SO"
fi
echo "program binary: $SO"
shasum -a 256 "$SO" 2>/dev/null || sha256sum "$SO"

echo "starting solana-test-validator on http://127.0.0.1:8899 (Ctrl-C to stop)"
exec solana-test-validator --reset --quiet --ledger "$ROOT/ledger" \
  --bpf-program "$PROGRAM_ID" "$SO"
