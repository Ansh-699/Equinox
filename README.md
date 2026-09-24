# Equinox frontend

The Next.js App Router frontend for Equinox, a Solana perpetual-
futures exchange for tokenized equities: Privy auth with explicit
multi-wallet selection, browser session-key trading relayed through an
authenticated Worker, MagicBlock Ephemeral Rollup execution-status
awareness, and Pyth-anchored oracle safety state -- all on Devnet.

This README covers this frontend only. For the on-chain program,
Worker/indexer, and MagicBlock protocol design, see the repo's own
`docs/architecture.md` and related protocol docs (not duplicated here).
For this frontend's own internal architecture (auth layering, session-key
trading, the typed-adapter pattern used everywhere data isn't fully
decoded yet, test-mode injection), see `docs/frontend-architecture.md`.

## Setup

```sh
npm install
cp .env.example .env.local   # fill in real values -- see below
npm run dev
```

Requires Node >=24.10.0 (see `package.json`'s `engines`) and npm (this
repo pins `npm@11.19.1` via `packageManager`).

### Environment

`.env.example` is the source of truth for every variable this app reads,
with inline comments on what's public vs. server-only and why. In short:

- A minimal local dev loop (no real login, no real chain calls) needs
  nothing beyond the defaults already in `.env.example`.
- Real Privy login needs `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
- Real trading needs a deployed market/vault
  (`NEXT_PUBLIC_EQUINOX_MARKET_ADDRESS` and friends) and a reachable,
  authenticated relayer (`EQUINOX_RELAYER_URL`,
  `NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS`).
- Going all the way to a real Devnet session is its own procedure, not
  just env vars -- see `docs/live-devnet-runbook.md`.

Never commit a filled-in `.env.local`; `scripts/secret-scan.sh` checks
for keypair arrays, JWKs, and known server-secret names leaking into
`.next/static` or elsewhere.

## Testing

```sh
npx tsc --noEmit        # type check
npx eslint .            # lint
npm test                # vitest -- unit tests for lib/ and features/ pure logic
npm run test:browser    # Playwright, real Chrome, against `next dev` + injectable test-wallet auth
npm run test:browser:production   # Playwright smoke tests against a real `next build && next start`
```

`npm run test:browser` uses `NEXT_PUBLIC_E2E_TEST_MODE=1` (double-gated
server-side to never activate outside `NODE_ENV !== "production"`) to
inject real client-side Ed25519 signing in place of a live Privy account
-- see `docs/frontend-architecture.md`'s test-mode section for exactly
how, and `docs/live-devnet-runbook.md` for what this suite deliberately
does not verify (a real Privy account, a real relayer, a real deployed
market instance).

Accessibility: `tests/browser/accessibility.spec.ts` runs an automated
axe-core scan; `tests/browser/keyboard-only.spec.ts` and
`tests/browser/mobile-viewport.spec.ts` drive real keyboard input and a
real mobile viewport. `docs/accessibility.md` is the honest manual
checklist -- what was actually verified, what wasn't, and explicitly not
a WCAG conformance claim.

## Current status and known limits

This branch holds six items pending a canonical protocol handoff (raw
order-book decoding, per-kind raw event decoding, raw oracle payload
decoding, a canonical-ABI migration, live relayer submission, and live
Devnet browser acceptance) rather than guessing at unverified byte
layouts or claiming a live pass that didn't happen. **A canonical ABI
package has since appeared on a sibling branch** -- see
`docs/abi-handoff-checklist.md` for exactly what it resolves, what it
doesn't, and the rebase procedure. Everywhere a byte layout isn't
verified yet, the corresponding UI honestly says so (open orders: "Open
orders require the canonical order-book layout manifest..."; Activity
feed: "details unavailable") rather than fabricating a value -- see
`docs/frontend-architecture.md`'s typed-adapter section for the pattern
used throughout.
