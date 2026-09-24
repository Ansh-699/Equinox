#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERIFY_LOG_DIR="${VERIFY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/equinox-verify.XXXXXX")}"
VERIFY_SUMMARY_PATH="${VERIFY_SUMMARY_PATH:-/tmp/equinox-verify-summary.json}"

run_logged() {
  local name="$1"
  shift
  "$@" 2>&1 | tee "$VERIFY_LOG_DIR/$name.log"
}

step() {
  printf '\n== %s ==\n' "$1"
}

step "Rust format"
run_logged rust-format env NO_DNA=1 cargo fmt --all -- --check

step "Rust workspace tests"
run_logged rust-tests env NO_DNA=1 cargo test --workspace

step "SBF build and artifact identity"
run_logged sbf-build bash -c 'NO_DNA=1 cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint && python3 scripts/verify-sbf-artifact.py target/deploy/equinox.so'

step "Rust runtime tests against the built SBF artifact"
run_logged rust-runtime-tests env NO_DNA=1 cargo test -p equinox --features runtime-tests

step "ABI parity"
run_logged abi npm run check:equinox-abi

step "V3 revision-2 layout fixture parity (Rust writer vs committed TS fixture)"
run_logged v3-layout-fixture npm run check:v3-layout-fixture

step "Frontend tests, types, lint and production build"
run_logged frontend-tests npm test
run_logged frontend-types npx tsc --noEmit
run_logged frontend-lint npm run lint
run_logged frontend-build npm run build

step "Worker tests and types"
run_logged worker-tests bash -c '(cd workers && npm test)'
run_logged worker-types bash -c '(cd workers && npm run check)'

step "Playwright fixture E2E"
run_logged playwright npm run test:browser

step "Secret scan"
run_logged secrets npm run check:secrets

node scripts/write-verify-summary.mjs "$VERIFY_LOG_DIR" "$VERIFY_SUMMARY_PATH"
printf 'verify summary: %s\n' "$VERIFY_SUMMARY_PATH"

printf '\nVERIFY-OK\n'
