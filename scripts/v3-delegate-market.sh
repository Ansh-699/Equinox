#!/usr/bin/env bash
# Delegates the deployed V3 market's 27-account execution bundle to the
# MagicBlock rollup (core first, then 18 book pages, 4 seat and 4 event shards).
# Signs with the market authority (~/.config/solana/id.json) -- run locally only.
set -euo pipefail
cd "$(dirname "$0")/.."
export V3_LIFECYCLE_STATE_PATH="${V3_LIFECYCLE_STATE_PATH:-$HOME/.local/state/stockstream/v3-e2e3-state.json}"; STATE="$V3_LIFECYCLE_STATE_PATH"
npx esbuild scripts/v3-tsla-delegation.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/.v3-delegate.bundle.mjs --log-level=warning
trap 'rm -f scripts/.v3-delegate.bundle.mjs' EXIT
API="${MARKET_API_URL:-https://stockstream-market-api.ansht.workers.dev}"
delegate() {
  for attempt in 1 2 3; do
    # Core delegation checks the oracle is fresh; refresh it just before (permissionless).
    [ "$1" = core ] && curl -s -X POST "$API/v1/oracle/refresh" >/dev/null
    CONFIRM_TSLA_DELEGATION_TARGET="$2" node scripts/.v3-delegate.bundle.mjs --target="$1" --submit | grep -q '"submitted": true' && { echo "delegated $1"; return 0; }
    sleep 3
  done
  echo "delegation failed: $1" >&2; return 1
}
export V3_CORE="$(python3 -c "import json;print(json.load(open('$STATE'))['core'])")" V3_INSTRUMENT="$(python3 -c "import json;print(json.load(open('$STATE'))['instrument'])")"
delegate core "$(python3 -c "import json;print(json.load(open('$STATE'))['core'])")"
python3 -c "
import json;d=json.load(open('$STATE'))['v3Accounts']
for i,a in enumerate(d['bookPages']): print(f'book-{i//9}-{i%9}',a)
for k in ('seat','event'):
  for i,a in enumerate(d[k+'Shards']): print(f'{k}-{i}',a)" | while read -r label address; do delegate "$label" "$address"; done
echo "27/27 delegated"
