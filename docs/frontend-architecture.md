# Frontend architecture

Scope: the Next.js App Router frontend under this repo (`app/`,
`features/`, `components/`, `lib/`). This document does not cover the
on-chain program, the Worker/indexer, or MagicBlock internals -- see
`docs/architecture.md`, `docs/magicblock.md`, `docs/orderbook.md`, etc.
for those (main-agent-owned; not duplicated here).

## Identity and auth: three layers, not one

Real Privy hooks throw if called outside a mounted `PrivyProvider`, and
"a wallet Privy discovered" is not the same thing as "the wallet the app
should trade with." Three layers separate those concerns:

1. **`PrivyIdentityContext`** (`components/privy-identity-context.tsx`) --
   the lowest level: what Privy (or, in test mode,
   `components/test-auth-provider.tsx`) actually discovered. Internal
   only; nothing outside `WalletSelectionProvider` should consume it
   directly.
2. **`WalletSelectionProvider`** (`components/wallet-selection-context.tsx`)
   -- turns discovery into an active choice. Selection is a pure
   derivation (`lib/wallet-selection.ts::resolveSelectedWallet`): an
   explicit choice wins, else a persisted one still present in the
   current wallet list, else auto-select when there's exactly one wallet,
   else fail closed to `null` -- **never** `wallets[0]` when multiple
   wallets are undecided. This same provider also owns the app-session
   lifecycle (`POST /api/auth/session`) bound to whichever wallet is
   currently selected, and tears it down immediately when the selection
   changes.
3. **Public `AppAuth`/`WalletSelection`/`WalletSignerContext`**
   (`components/auth-context.tsx`, `components/wallet-signer-context.tsx`)
   -- what every feature component actually imports. `AppAuth.
   authenticated` means "Privy authenticated AND a wallet is selected AND
   the app session for that wallet is established" -- a valid Privy login
   alone never implies this.

Wallet-switch teardown is the same pure-derivation pattern one level
down: `features/sessions/use-trading-session.ts`'s session `status` is
derived by filtering the raw session state against the *current*
`ownerWallet`, so a stale owner's session is never visible for even one
render after a switch, with a side-effect-only `useEffect` doing the
actual in-memory key destruction alongside it.

## Session-key trading

One main-wallet signature authorizes an on-chain `TradingSession` bound
to a browser-generated, memory-only Ed25519 keypair
(`lib/session-trading.ts`, `lib/browser-session.ts`). Every subsequent
trading action is signed by that session key and relayed through
`app/api/relay/session` (same-origin proxy) to the Worker's authenticated
relayer -- the browser never holds the relayer's own credential. The
session's nonce is strict-equality-checked on-chain
(`SessionNonceReplay`); the client only ever advances it after an
action's signature is actually confirmed by the relayer response,
never speculatively.

## Typed adapter boundaries -- the pattern used everywhere data isn't fully verified yet

This codebase does not decode a byte layout it hasn't verified against
the real Rust source. Every place that would otherwise be tempted to
guess follows the same shape: a pure module in `lib/` defines an
explicit state machine or classification function over already-verified
inputs, with an honest "unavailable"/fail-closed value for anything it
can't determine -- never a fabricated one. This is deliberate and
repeated on purpose, not incidental:

- `lib/execution-status.ts` -- MagicBlock/ER execution status
  (`orderRoutingDomain`, `describeExecutionStatus`), built from the
  indexer's own already-reconciled 11-state enum.
- `lib/oracle-safety.ts` -- oracle safety state, built ONLY from the
  verified account header fields (`oracleValid`/
  `lastVerifiedOracleTimestamp`) and fully-decoded event KIND NAMES
  (the 2-byte discriminator) -- never the event's own undecoded
  category-specific payload body.
- `lib/sequence-recovery.ts` -- per-domain (L1/ER) event-sequence gap/
  duplicate/reconnect detection for the market event WebSocket.
- `lib/activity-view-model.ts` -- Activity feed rendering, with an
  explicit `ACTIVITY_DETAIL_UNAVAILABLE` fallback rather than a guessed
  event detail.
- `lib/open-orders.ts` -- the open-orders data boundary. Configured V3
  markets use `createV3OpenOrdersAdapter`, which reads the Worker's complete
  versioned shard aggregate and fails closed on missing or malformed state.
  `unimplementedOpenOrdersAdapter` is retained only as the explicit V2/
  unknown-version fallback; it never decodes the legacy monolithic market.
  The UI/hook (`features/orders/`) remains transport-independent.

When you're about to decode something new, look for whether it already
has (or should have) a module here first, rather than inlining a
`DataView` read into a component.

## Test-mode injection

`NEXT_PUBLIC_E2E_TEST_MODE=1` swaps `PrivyIdentityContext`'s real Privy
bridge for `components/test-auth-provider.tsx`, which generates real
Ed25519 keypairs client-side (deterministic per index, so a persisted
selection survives a page reload in tests) and signs real transaction
bytes -- structurally the same thing a real wallet does, without the
Privy network round trip. It is double-gated: the server side
(`lib/auth/e2e-test-mode.ts`) additionally requires `NODE_ENV !==
"production"`, so this can never activate in a production build/start
regardless of how the public env var is set. `?e2eWallets=N` (1-5)
controls how many wallets it exposes, for testing both the auto-select
and the explicit-choice paths. See `docs/testing.md` in this repo (the
section below) for how this is used across the Playwright suite --
distinct from the protocol-level `docs/testing.md` at the repo root
covering Rust/Worker tests, if you're in the combined checkout.

## Where to look next

- Wallet selection and session-key details: read the modules named above
  directly: they're short and each carries the "why," not just the
  "what," in its own doc comment.
- Accessibility posture and what was actually verified vs. not:
  `docs/accessibility.md`.
- What's blocked on the canonical ABI and exactly why:
  `docs/abi-handoff-checklist.md`.
- Going from this branch's mocked E2E suite to a real Devnet session:
  `docs/live-devnet-runbook.md`.
