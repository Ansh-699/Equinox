#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

step() {
  printf '\n== %s ==\n' "$1"
}

step "Rust format"
NO_DNA=1 cargo fmt --all -- --check

step "Rust workspace tests"
NO_DNA=1 cargo test --workspace

step "SBF build and artifact identity"
NO_DNA=1 cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint
python3 scripts/verify-sbf-artifact.py target/deploy/stockstream.so

step "ABI parity"
npm run check:stockstream-abi

step "Frontend tests, types, lint and production build"
npm test
npx tsc --noEmit
npm run lint
npm run build

step "Worker tests and types"
(cd workers && npm test && npm run check)

step "Playwright fixture E2E"
npm run test:browser

step "Secret scan"
npm run check:secrets

printf '\nVERIFY-OK\n'
