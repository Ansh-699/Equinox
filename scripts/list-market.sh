#!/usr/bin/env bash
# Lists a reporter-priced perp end to end: a graduated Meteora launch (priced
# from its DAMM v2 pool, per lot of tokens) or another PreStocks token.
#   scripts/list-market.sh <SYMBOL> <feed-id> meteora <damm-v2-pool> <base-mint> [lot=1000000]
#   scripts/list-market.sh <SYMBOL> <feed-id> prestocks <PRESTOCKS_TOKEN> <token-mint>
# Steps: create the market (~1.3 devnet SOL from the authority) -> name the VM
# keeper as reporter and keeper -> add it to config/stockstream-deployment.json
# -> rebuild the VM service (reporter starts posting) -> seat and fund the bots
# -> delegate the 27 accounts -> restart the service (bots start quoting).
# Signs with the market authority (~/.config/solana/id.json) -- run locally only.
set -euo pipefail
cd "$(dirname "$0")/.."
symbol="${1:?symbol}"; feed="${2:?feed id}"; kind="${3:?meteora|prestocks}"; source="${4:?pool or token}"; mint="${5:?base mint}"; lot="${6:-1000000}"
market="$symbol-PERP"; name="$(echo "$symbol" | tr A-Z a-z)"
KEEPER="${KEEPER:-7JuUhGGGcu2t2De6VQecNCqhWPwu8QzmztWXW9kYNKFz}"
VM="${VM:-azureuser@4.194.209.138}"; SSH_KEY="${SSH_KEY:-$HOME/.ssh/digitalocean}"
prefix=$([ "$kind" = meteora ] && echo LAUNCH || echo PRESTOCKS)

scripts/preipo-market.sh "$symbol" "$feed" "$prefix"
export V3_LIFECYCLE_STATE_PATH="$HOME/.local/state/stockstream/preipo-$name-state.json"
node scripts/v3-set-keeper.mjs reporter "$KEEPER"
node scripts/v3-set-keeper.mjs "$KEEPER"

python3 - "$market" "$symbol" "$kind" "$source" "$mint" "$lot" "$feed" <<'PY'
import json, os, sys
market, symbol, kind, source, mint, lot, feed = sys.argv[1:]
p = "config/stockstream-deployment.json"; d = json.load(open(p))
s = json.load(open(os.path.expanduser(f"~/.local/state/stockstream/preipo-{symbol.lower()}-state.json")))
oracle = {"kind": "meteora", "pool": source, "mint": mint, "lot": float(lot), "feedId": int(feed)} if kind == "meteora" else {"kind": "prestocks", "token": source, "mint": mint, "feedId": int(feed)}
entry = {"symbol": market, "name": symbol + (f" (per {int(float(lot)):,} tokens)" if kind == "meteora" else ""), "kind": "launch" if kind == "meteora" else "pre-ipo",
         "core": s["core"], "oracleSnapshot": s["oracleSnapshot"], "lookupTable": s["lookupTable"], "oracle": oracle}
d["markets"] = [m for m in d["markets"] if m["symbol"] != market] + [entry]
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
print("registered", market)
PY

deploy_vm() {
  tar -czf - config/stockstream-deployment.json programs/stockstream/src programs/stockstream/Cargo.toml services/market-maker/src services/market-maker/Cargo.toml services/market-maker/Cargo.lock \
    | ssh -i "$SSH_KEY" "$VM" 'cd ~/stockstream-build && tar -xzf - && sudo docker build -q -f services/market-maker/Dockerfile -t stockstream-mm . >/dev/null && id=$(sudo docker create stockstream-mm) && sudo docker cp $id:/usr/local/bin/stockstream-market-maker /tmp/mm.new && sudo docker rm $id >/dev/null && sudo install -m 755 /tmp/mm.new /usr/local/bin/stockstream-market-maker && sudo systemctl restart stockstream-mm'
}
deploy_vm
echo "waiting for the reporter's first price…"; sleep 30
npx tsx scripts/preipo-bots.mts "preipo-$name"
bash scripts/v3-delegate-market.sh
ssh -i "$SSH_KEY" "$VM" 'sudo systemctl restart stockstream-mm'
echo "$market listed. Deploy the frontend (npm run deploy:vinext) so it appears in the market picker."
