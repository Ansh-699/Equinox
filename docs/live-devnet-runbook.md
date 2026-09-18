# Live-Devnet runbook

This is the procedure for going from "the mocked Playwright suite passes"
to "a real browser, a real wallet, and a real Devnet session." It is a
runbook, not a status report -- it lists what must be true and how to
verify each one, and says plainly where this branch currently stands
against each item. It does not perform any of these steps itself: live
relayer submission and live Devnet browser acceptance are two of the six
items this branch has held throughout (see `AGENTS.md`/the standing
instructions this branch was built under), and remain held here.

## 1. Turn off test mode

`NEXT_PUBLIC_E2E_TEST_MODE` must be unset (or `0`) in the real
deployment's environment. It is already double-gated -- `lib/auth/
e2e-test-mode.ts` additionally requires `NODE_ENV !== "production"`
server-side -- so a real `next build && next start` cannot activate it
regardless, but a `next dev` deployment could if the env var is set
carelessly. Verify: `curl <deployment>/api/health` or inspect the
rendered page for the "Sign in" button actually invoking Privy (test mode
never reaches this branch's Privy hooks at all -- see
`docs/frontend-architecture.md`'s test-mode section).

## 2. Real Privy configuration

- `NEXT_PUBLIC_PRIVY_APP_ID` -- a real Privy app id (public, safe to
  ship in the bundle).
- `PRIVY_APP_SECRET` -- server-side only, used by `lib/auth/session.ts`'s
  `verifyPrivyAccessToken`. **Status: not configured in this branch's
  `.env.example` (empty placeholder)** -- must be sourced from the real
  Privy dashboard and set through untracked environment storage, never
  committed.
- Confirm the Privy app's allowed origins/redirect config actually
  includes the real deployment's origin, or login will fail at the Privy
  layer before this app ever sees a token.

## 3. Real Devnet RPC

`NEXT_PUBLIC_SOLANA_RPC_URL` -- the public default
(`https://api.devnet.solana.com`) works but is rate-limited; a real
deployment should use a dedicated Devnet RPC endpoint. **Never** put an
API-key-bearing RPC URL behind a `NEXT_PUBLIC_` name -- it ships in the
browser bundle. If a keyed endpoint is needed, it has to be proxied
server-side (this branch does not currently have such a proxy for the
browser-side RPC path; `lib/rpc-transport.ts`'s `SolanaRpcTransport`
calls the configured URL directly from the browser).

## 4. A deployed program, market, and vault on Devnet

- `STOCKSTREAM_PROGRAM_ID` is already fixed:
  `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET` (see `.env.example`).
  Confirm the actual deployed program at that address on Devnet matches
  what this branch's `clients/stockstream/src/index.ts` decoders expect
  (`MARKET_VERSION`, account sizes) -- **do this check explicitly**;
  see `docs/abi-handoff-checklist.md` if the canonical ABI package has
  landed by the time this runs, since offsets may have moved.
- `NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS`,
  `NEXT_PUBLIC_STOCKSTREAM_SETTLEMENT_SCRATCH_ADDRESS`,
  `NEXT_PUBLIC_STOCKSTREAM_VAULT`, `NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY`
  -- all empty in `.env.example` today. These need real, initialized
  Devnet accounts before any transaction this app constructs will land
  successfully; this branch's UI constructs unsigned previews of the
  init instructions (`LifecyclePanel`'s "Construct seat + scratch"/
  "Construct vault" buttons) but does not itself stand up the market.

## 5. A reachable, authenticated relayer

`STOCKSTREAM_RELAYER_URL` defaults to `http://localhost:8787` in
`.env.example` -- a real deployment needs this pointed at the actual
deployed Worker. Beyond reachability:

- `.env.example`'s own comment on `STOCKSTREAM_RELAYER_TOKEN` records a
  **known gap as of this branch**: the Worker route had no per-user auth
  of its own, only a shared bearer conflated with keeper ingestion. The
  main-agent branch (`stockstream/core-auth-sprint`) has since landed
  commits titled "wire the relay route to authoritative Privy auth" and
  "authoritative Privy relayer auth: 20-step verification chain" --
  **verify directly against whichever branch is actually deployed**
  whether this gap is closed, rather than trusting either this stale
  comment or the commit titles alone.
- `NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS` (the relayer's public fee-
  payer address) must be set and must match a real, funded fee-payer the
  Worker actually signs with -- `.env.example` notes this stays unset
  today because nothing in this branch's view of `workers/` assigns
  `globalThis.__stockstreamRelayerSigner`, which makes every relay
  request fail closed with `fee_payer_unavailable`
  (`lib/session-relay-status.ts`) rather than silently proceeding.
  Confirm this is actually wired on whichever Worker deployment is used.

## 6. Verification pass, in order

Once 1-5 are actually true (not assumed):

1. Load the deployed app in a real browser. Confirm "Sign in" opens the
   real Privy flow (not test mode) and completes.
2. Confirm the wallet-selection UI behaves per
   `docs/frontend-architecture.md` -- single wallet auto-selects,
   multiple wallets require an explicit choice, nothing signs until then.
3. Deposit a small amount of real Devnet USDC and confirm the vault
   balance readback matches.
4. Authorize a trading session (one main-wallet prompt) and confirm the
   on-chain readback the app performs after submitting
   (`features/sessions/use-trading-session.ts`'s post-authorize
   verification) actually matches what was requested.
5. Place one small order and confirm it relays with zero additional
   main-wallet prompts, and that the notice shows a real signature.
6. Exercise a revoke and confirm a subsequent order attempt is rejected
   client-side before it's even sent.
7. Only after 1-6 pass cleanly should this be treated as "live Devnet
   browser acceptance" -- a mocked Playwright pass, however thorough, is
   not a substitute for this pass actually happening against the real
   stack.

## What this branch has verified vs. not, honestly

Everything under `tests/browser/*.spec.ts` runs against `next dev` with
`NEXT_PUBLIC_E2E_TEST_MODE=1` and mock RPC/relayer/market-API servers
(`tests/browser/mock-*.mjs`) -- real Chrome, real WebSocket frames, real
client-side signing with real (test) Ed25519 keys, but never a real
Privy account, a real deployed program instance, or a real relayer. The
one exception is `tests/browser-production/smoke.spec.ts`
(`playwright.production.config.ts`), which runs against a real
`next build && next start` but is deliberately smoke-only (no login is
possible there at all, per point 1 above). None of this substitutes for
the verification pass in section 6.
