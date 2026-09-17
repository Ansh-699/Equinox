#!/usr/bin/env bash
# Installs and verifies the pinned StockStream SBF toolchain.
#
# The single source of truth for versions is toolchain/stockstream-runtime.env.
# Each tool is checked against its own expected version: the Agave release and
# the platform-tools/cargo-build-sbf pair carry different version numbers, so a
# single "does the string contain the Agave version" check silently passes a
# mixed (and non-loadable) toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../toolchain/stockstream-runtime.env
source "$ROOT/toolchain/stockstream-runtime.env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

if ! command -v agave-install >/dev/null 2>&1; then
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://release.anza.xyz/v${AGAVE_VERSION}/install" \
    -o /tmp/stockstream-agave-install.sh
  sh /tmp/stockstream-agave-install.sh
fi

# NOTE: the exact release tag for Agave 4.2.1 may be a `stable-<hash>` channel
# name rather than the bare version. If this step does not switch the active
# release, activate the installed release explicitly and re-run; the version
# assertions below are what actually gate the build.
agave-install init "$AGAVE_VERSION"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

SOLANA_VERSION="$(solana --version)"
BUILD_SBF_VERSION="$(cargo-build-sbf --version)"
VALIDATOR_VERSION="$(solana-test-validator --version)"
printf '%s\n' "$SOLANA_VERSION" "$BUILD_SBF_VERSION" "$VALIDATOR_VERSION"

require() {
  # require <label> <haystack> <needle>
  case "$2" in
    *"$3"*) ;;
    *) echo "toolchain mismatch: $1 is not $3 -- got: $2" >&2; exit 1 ;;
  esac
}

require "solana-cli" "$SOLANA_VERSION" "$AGAVE_VERSION"
require "solana-test-validator" "$VALIDATOR_VERSION" "$AGAVE_VERSION"
require "cargo-build-sbf" "$BUILD_SBF_VERSION" "$EXPECTED_CARGO_BUILD_SBF"
require "platform-tools" "$BUILD_SBF_VERSION" "$EXPECTED_PLATFORM_TOOLS"

cargo build-sbf --manifest-path "$ROOT/programs/stockstream/Cargo.toml" --features bpf-entrypoint
python3 "$ROOT/scripts/verify-sbf-artifact.py" "$ROOT/target/deploy/stockstream.so"
cargo test -p stockstream
