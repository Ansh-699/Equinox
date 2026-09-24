#!/usr/bin/env bash
# Creates a pre-IPO perp market (PreStocks-priced) on the existing V3 exchange:
# same collateral mint and config as TSLA-PERP, a reserved feed id (no Pyth feed
# exists for a private company), prices at exponent -5 like every V3 market.
# Usage: scripts/preipo-market.sh <SYMBOL> <feed-id> [PREFIX=PRESTOCKS]   e.g. OPENAI 4000000001
# Signs with the market authority (~/.config/solana/id.json) -- run locally only.
set -euo pipefail
cd "$(dirname "$0")/.."
symbol="${1:?symbol}"; feed="${2:?feed id}"; prefix="${3:-PRESTOCKS}"
STATE_DIR="${STOCKSTREAM_STATE_DIR:-$HOME/.local/state/stockstream}"
state="$STATE_DIR/preipo-$(echo "$symbol" | tr A-Z a-z)-state.json"
[ -f "$state" ] || python3 -c "
import json; base=json.load(open('$STATE_DIR/v3-e2e3-state.json'))
json.dump({'version':3,'mint':base['mint']}, open('$state','w'), indent=2)"
export V3_LIFECYCLE_STATE_PATH="$state"
export V3_EXISTING_EXCHANGE="$(python3 -c "import json;print(json.load(open('config/stockstream-deployment.json'))['exchange'])")"
export V3_INSTRUMENT_ID_HEX="$(python3 -c "print(b'$prefix:$symbol'.ljust(32, b'\0').hex())")"
export V3_ORACLE_FEED_ID="$feed" V3_ORACLE_SYMBOL="$prefix.$symbol/USD" V3_ORACLE_CHANNEL=fixed_rate@1000ms V3_ORACLE_EXPONENT=-5
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
node scripts/v3-devnet-lifecycle.mjs --execute setup
npx esbuild scripts/v3-e2e.ts --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/v3-e2e.mjs --log-level=warning
node node_modules/.cache/v3-e2e.mjs lookup
python3 -c "import json; d=json.load(open('$state')); print(json.dumps({k: d.get(k) for k in ('core','instrument','oracleSnapshot','vault','lookupTable')}))"
