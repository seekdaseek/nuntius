#!/usr/bin/env bash
# Local validator running the Solana Subscriptions program, built from source at
# the release commit the program's own CHANGELOG says is deployed on mainnet.
#
#   scripts/localnet.sh            # fetch + build (first run), then start the validator
#   LOCALNET_RPC=http://127.0.0.1:8899 npm --prefix server test
#
#   scripts/localnet.sh --meteora  # the same, plus Meteora's programs cloned from mainnet
#
# --meteora clones, as deployed on mainnet and read at start: Meteora's Dynamic Bonding
# Curve and DAMM v2 programs, Metaplex Token Metadata (DBC writes each launch token's
# metadata through it), and the DAMM v2 configs a DBC curve migrates into. Nothing of
# their source is fetched or built. They are read from CLONE_RPC (default: the public
# mainnet endpoint; it is never printed).
#
# Linux x86_64 or macOS (arm64/x86_64). Needs git, curl, a Rust toolchain via rustup.
# Everything is placed under $NUNTIUS_LOCALNET (default ~/.cache/nuntius-localnet).
set -euo pipefail

METEORA=0
[ "${1:-}" = "--meteora" ] && METEORA=1

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

CLONES=()
LEDGER="$ROOT/ledger"
if [ "$METEORA" = 1 ]; then
  DBC_PROGRAM="dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
  DAMM_V2_PROGRAM="cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
  METAPLEX_PROGRAM="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  # DAMM_V2_MIGRATION_FEE_ADDRESS in @meteora-ag/dynamic-bonding-curve-sdk 1.5.13:
  # FixedBps100 (migration fee option 2, the preset's) and Customizable (option 6).
  DAMM_V2_CONFIG_FIXED_BPS_100="Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"
  DAMM_V2_CONFIG_CUSTOMIZABLE="A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"
  # DBC's pool authority PDA (system-owned, holding SOL on mainnet) pays the DAMM v2 pool's
  # rent when a curve migrates. Found from the failing simulation, not guessed: without it,
  # migration fails in DAMM v2 InitializePool with "Transfer: insufficient lamports 0".
  DBC_POOL_AUTHORITY="FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
  CLONES=(--url "${CLONE_RPC:-https://api.mainnet-beta.solana.com}"
    --clone-upgradeable-program "$DBC_PROGRAM"
    --clone-upgradeable-program "$DAMM_V2_PROGRAM"
    --clone-upgradeable-program "$METAPLEX_PROGRAM"
    --clone "$DAMM_V2_CONFIG_FIXED_BPS_100"
    --clone "$DAMM_V2_CONFIG_CUSTOMIZABLE"
    --clone "$DBC_POOL_AUTHORITY")
  LEDGER="$ROOT/ledger-meteora"
  echo "cloning from mainnet: DBC $DBC_PROGRAM, DAMM v2 $DAMM_V2_PROGRAM, Metaplex $METAPLEX_PROGRAM, 2 DAMM v2 configs, DBC's pool authority"
fi

echo "starting solana-test-validator on http://127.0.0.1:8899 (Ctrl-C to stop)"
exec solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$SO" ${CLONES[@]+"${CLONES[@]}"}
