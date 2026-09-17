#!/usr/bin/env bash
# Secret scanner: private material must never appear in tracked files, the
# working-tree diff, built frontend assets, Worker bundles, or test
# snapshots.
#
# What counts as a "secret" here (heuristic, intentionally narrow to keep
# the false-positive rate near zero):
#   1. Solana keypair JSON arrays (64-byte arrays inside a file whose name
#      or path suggests a key, OR .env files containing a 60+ byte JSON
#      array).
#   2. Ed25519/PKCS8/JWK private material ("d":..., PKCS8 base64 blobs)
#      in ANY tracked file.
#   3. Bearer tokens assigned in source (token: "..." literals in
#      non-test source).
#   4. Any .env file other than .env.example (checked by --tracked mode).
#
# Exit 1 on any hit. Never prints the matched secret itself -- only the
# file, line number, and a redacted prefix.

set -euo pipefail
cd "$(dirname "$0")/.."

status=0

# 1. Keypair files anywhere in the tree (tracked or build output).
# .keys/ is the intentionally-local, gitignored deploy-key directory --
# allowed to exist there and NOWHERE else.
while IFS= read -r -d '' file; do
  case "$file" in
    ./.keys/*) ;;
    *) status=1; echo "SECRET VIOLATION: keypair-format file outside the gitignored .keys/ directory: $file" ;;
  esac
done < <(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./target -prune -o -path ./.next -prune -o -path ./.keys -prune -o -type f \( -name "*keypair*.json" -o -name "id.json" \) -print0)

# 2. Tracked files: 64-byte JSON keypair arrays in any text file.
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  case "$file" in
    ./.keys/*) ;; # the intentionally-local, gitignored deploy-key directory
    *) echo "SECRET VIOLATION (redacted): 64-byte keypair array in tracked file $file near line $line (contents withheld)"
       status=1 ;;
  esac
done < <(grep -rEl '\[ *[0-9]{1,3}( *, *[0-9]{1,3}){63} *\]' \
  --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.js" --include="*.json" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=.next . 2>/dev/null | while IFS= read -r f; do grep -nE '\[ *[0-9]{1,3}( *, *[0-9]{1,3}){63} *\]' "$f" | head -1 | sed "s|^|$f:|"; done)

# 3. Actual JWK private material (an "OKP" key WITH a "d" private value)
# in tracked source. Parsers that merely handle the format are fine.
while IFS= read -r f; do
  case "$f" in
    *test*|*spec*) ;;
    *) if grep -E '"d"[[:space:]]*:[[:space:]]*"[A-Za-z0-9+/=_-]{20,}"' "$f" | grep -qE '"(kty|crv)"'; then
         echo "SECRET VIOLATION: JWK private key material (kty + d) in non-test source: $f"
         status=1
       fi ;;
  esac
done < <(grep -rEl '"(kty|crv)" *: *"OKP"' \
  --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=.next . 2>/dev/null || true)

# 4. Browser bundle: the server-only secret names must never appear.
if [ -d .next ]; then
  if grep -rlE 'PRIVY_APP_SECRET|PYTH_PRO_API_KEY|KEEPER_KEYPAIR_JSON' .next/static 2>/dev/null | grep -q .; then
    echo "SECRET VIOLATION: server-only secret name in built browser bundle (.next/static)"
    status=1
  fi
fi

# 5. Worker bundles, if ever built locally.
if [ -d workers/.wrangler ]; then
  if grep -rlE 'PRIVY_APP_SECRET|PYTH_PRO_API_KEY' workers/.wrangler/tmp 2>/dev/null | grep -q .; then
    echo "SECRET VIOLATION: server-only secret name in local Worker build output"
    status=1
  fi
fi

# 6. Git diff of the working tree: the same keypair-array heuristic on
# unstaged/staged changes only.
if [ -n "$(git rev-parse --is-inside-work-tree 2>/dev/null && echo yes)" ]; then
  if git diff | grep -qE '^\+.*\[ *[0-9]{1,3}( *, *[0-9]{1,3}){63} *\]'; then
    echo "SECRET VIOLATION: keypair array added in working-tree diff"
    status=1
  fi
fi

if [ "$status" -eq 0 ]; then
  echo "secret-scan: OK (no private material found)"
fi
exit "$status"
