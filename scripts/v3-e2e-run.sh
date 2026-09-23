#!/usr/bin/env bash
# Full fresh-market Devnet lifecycle: setup -> seats -> trader deposits -> L1
# snapshot -> 27-account ER delegation -> ER maker/taker fill -> sharded
# commit -> ER close -> commit+undelegate -> restore/reconcile -> withdrawals.
# Usage: scripts/v3-e2e-run.sh <state-name>   (e.g. v3-e2e3)
# Needs PYTH_PRO_API_KEY (.env.local) and a funded ~/.config/solana/id.json.
set -euo pipefail
cd "$(dirname "$0")/.."
name="${1:?state name required}"
set -a; . ./.env.local; set +a
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-$(grep -E '^SOLANA_RPC_URL=' workers/.dev.vars | cut -d= -f2- | tr -d '"')}"
STATE_DIR="${STOCKSTREAM_STATE_DIR:-$HOME/.local/state/stockstream}"; mkdir -p "$STATE_DIR"
export V3_LIFECYCLE_STATE_PATH="$STATE_DIR/$name-state.json" V3_EXCHANGE_KEY_PATH="$STATE_DIR/$name-exchange.json" V3_TAKER_KEY_PATH="$STATE_DIR/$name-taker.json"
export V3_ORACLE_FEED_ID=1435 V3_ORACLE_SYMBOL=Equity.US.TSLA/USD V3_ORACLE_CHANNEL=fixed_rate@50ms V3_ORACLE_EXPONENT=-5

bundle() { npx esbuild "scripts/$1" --bundle --platform=node --format=esm --packages=external --outfile="$2" --log-level=warning; }
bundle v3-e2e.ts node_modules/.cache/v3-e2e.mjs
bundle v3-tsla-delegation.ts scripts/.v3-delegate.bundle.mjs # resolves the manifest relative to scripts/
trap 'rm -f scripts/.v3-delegate.bundle.mjs' EXIT
run() { node node_modules/.cache/v3-e2e.mjs "$@"; }
field() { python3 -c "import json;print(json.load(open('$V3_LIFECYCLE_STATE_PATH'))['$1'])"; }

node scripts/v3-devnet-lifecycle.mjs --execute setup >/dev/null
export V3_CORE="$(field core)" V3_INSTRUMENT="$(field instrument)"
echo "market core $V3_CORE"
run seats && run fund && run lookup
delegate() {
  for attempt in 1 2 3; do
    CONFIRM_TSLA_DELEGATION_TARGET="$2" node scripts/.v3-delegate.bundle.mjs --target="$1" --submit | grep -q '"submitted": true' && return 0
    sleep 3
  done
  echo "delegation failed: $1" >&2; return 1
}
run snapshot && delegate core "$V3_CORE"
python3 -c "
import json;d=json.load(open('$V3_LIFECYCLE_STATE_PATH'))['v3Accounts']
for i,a in enumerate(d['bookPages']): print(f'book-{i//9}-{i%9}',a)
for k in ('seat','event'):
  for i,a in enumerate(d[k+'Shards']): print(f'{k}-{i}',a)" | while read -r label address; do delegate "$label" "$address"; done
echo "27/27 delegated"
run trade
V3_SHARDED_COMMIT_STATE_PATH="$STATE_DIR/$name-commit.json" node scripts/v3-sharded-commit.mjs commit | tail -1
run close
V3_SHARDED_COMMIT_STATE_PATH="$STATE_DIR/$name-undelegate.json" node scripts/v3-sharded-commit.mjs undelegate | tail -1
run restore && run withdraw
