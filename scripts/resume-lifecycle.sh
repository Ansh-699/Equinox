#!/usr/bin/env bash
# Safe continuation command after the Devnet wallet receives enough SOL.
# Confirms Devnet, the wallet, the balance, loads the resumable manifest,
# and starts at the first incomplete lifecycle stage. Never targets mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. Confirm cluster is Devnet =="
URL=$(solana config get | grep "RPC URL" | awk '{print $3}')
case "$URL" in
  *mainnet*) echo "REFUSING: config points at mainnet"; exit 1;;
  *devnet*|*localhost*|*127.0.0.1*) echo "cluster: $URL (devnet-recognized) OK";;
  *) echo "REFUSING: unrecognized endpoint $URL"; exit 1;;
esac

WALLET=$(solana-keygen pubkey ~/.config/solana/id.json)
echo "== 2. Deploy wallet: $WALLET_PUBLIC =="
BAL=$(solana balance --url devnet --lamports | tr -d ' ')
echo "balance: $BAL lamports"

echo "== 3. Load the cost requirement =="
MIN=$(node scripts/devnet-cost.mjs --json > /dev/null 2>&1 && node -e "
const s = JSON.parse(require('fs').readFileSync('/tmp/opencode/lifecycle-state.json','utf8'));
console.log(s.cost?.recommendedSOL ?? 'fail');
")
case "$MIN" in ""|*[!0-9.]*) echo "cost calculation missing; run scripts/devnet-cost.mjs"; exit 1;; esac
NEED=$(python3 -c "print(int(float('$MIN') * 1e9))")
echo "recommended minimum: $MIN SOL ($MIN lamports)"
MIN_LAMPORTS=$(python3 -c "print(int(float('$MIN')*1e9))")
if [ "$BAL" -lt "$MIN_LAMPORTS" ]; then
  echo "INSUFFICIENT: balance $BAL < required $MIN_LAMPORTS lamports."
  echo "Send at least $(python3 -c "print(round(($MIN_LAMPORTS-$BAL)/1e9,4))") SOL to $(solana-keygen pubkey ~/.config/solana/id.json) and rerun."
  exit 1
fi
echo "balance meets the calculated minimum OK"

echo "== 4. Verify program identity =="
PROGRAM_ID=$(solana-keygen pubkey .keys/stockstream-program-keypair.json)
case "$PROGRAM_ID" in
  H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET) echo "program: $PROGRAM_ID OK";;
  *) echo "REFUSING: program keypair mismatch ($PROGRAM_ID)"; exit 1;;
esac
# Cluster identity via genesis hash consistency (no mainnet)
GENESIS=$(solana genesis-hash --url devnet)
case "$GENESIS" in
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) echo "genesis OK (devnet)";;
  *) echo "REFUSING: unexpected genesis $GENESIS"; exit 1;;
esac

echo "== 5. Funded upgrade (if needed) =="
node scripts/verify-deployment.mjs > /dev/null 2>&1 || true
CHECK=$(node -e "
const s = JSON.parse(require('fs').readFileSync('/tmp/opencode/lifecycle-state.json','utf8'));
if (s.deploymentCheck && !s.deploymentCheck.byteEqual) {
  console.log('upgrade-needed');
} else console.log('current');
")
if [ "$CHECK" = "upgrade-needed" ]; then
  echo "upgrading the deployed program to the current local artifact..."
  solana program deploy target/deploy/stockstream.so --url devnet \
    --program-id H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET \
    --upgrade-authority ~/.config/solana/id.json \
    --fee-payer ~/.config/solana/id.json --output json
  node scripts/verify-deployment.mjs > /dev/null 2>&1
fi

echo "== 6. Lifecycle: first incomplete stage =="
node scripts/devnet-lifecycle.mjs all
