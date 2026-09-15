#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The installer and release archive are fetched from the official Anza release
# channel. It installs the complete release, including matching platform-tools.
source "$ROOT/toolchain/stockstream-runtime.env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

if ! command -v agave-install >/dev/null 2>&1; then
  curl --fail --location --proto '=https' --tlsv1.2 https://release.anza.xyz/v${AGAVE_VERSION}/install -o /tmp/stockstream-agave-install.sh
  sh /tmp/stockstream-agave-install.sh
fi
agave-install init "$AGAVE_VERSION"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

SOLANA_VERSION="$(solana --version)"
BUILD_SBF_VERSION="$(cargo-build-sbf --version)"
VALIDATOR_VERSION="$(solana-test-validator --version)"
printf '%s\n' "$SOLANA_VERSION" "$BUILD_SBF_VERSION" "$VALIDATOR_VERSION"
case "$SOLANA_VERSION $BUILD_SBF_VERSION $VALIDATOR_VERSION" in
  *"$AGAVE_VERSION"*) ;;
  *) echo "installed tools are not all pinned to Agave $AGAVE_VERSION" >&2; exit 1 ;;
esac

cargo build-sbf --manifest-path "$ROOT/programs/stockstream/Cargo.toml" --features bpf-entrypoint
cargo test -p stockstream
