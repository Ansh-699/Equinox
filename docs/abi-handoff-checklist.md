# ABI handoff checklist and rebase procedure

**Status as of this writing: a canonical ABI package already exists on
`stockstream/core-auth-sprint` but has not been merged into this branch
(`stockstream/frontend-product`) or acted on.** This document exists so
that whoever picks this up next — human or agent — doesn't have to
re-derive what's here from scratch.

## What actually changed (verified by reading the commits directly, not assumed)

`stockstream/core-auth-sprint` is 12 commits ahead of the point this branch
forked from (merge-base `bea420a`). Three of those commits are the ABI
package:

- `1aea6db` "publish canonical StockStream ABI package" — adds
  `clients/stockstream/src/abi/{accounts,constants,errors,events,index,
  instructions,oracle,orderbook,pda,sessions}.ts` and `layout.json`.
- `831935d` "add Rust ABI manifest generator with CI parity test" — adds
  `programs/stockstream/tests/abi_manifest.rs`, a small `book.rs` change,
  and the generated `layout.json` the TS constants are transcribed from.
- `64117c1` "add generate/check ABI parity npm scripts" — adds
  `npm run generate:stockstream-abi` / `npm run check:stockstream-abi`,
  which regenerate `layout.json` from the Rust source via `cargo test`
  and diff it against the checked-in copy. This is a real, CI-enforceable
  parity gate, not a hand-maintained set of constants that can silently
  drift from the program.

**Verified: this is purely additive.** `git diff --name-only` between the
merge-base and each branch's tip shows exactly two overlapping files
between what this branch changed and what `core-auth-sprint` changed:
`package.json` and `package-lock.json` (see "Rebase procedure" below for
the exact, trivial diff). Nothing in `clients/stockstream/src/index.ts`
(the module every frontend file in this branch actually imports from) was
touched by the ABI package commits — the new layout lives entirely under
a new `clients/stockstream/src/abi/` directory. A rebase of this branch
onto current `core-auth-sprint` should apply cleanly with no code
conflicts.

## What this unblocks, precisely — and what it does NOT

Do not assume the ABI package resolves every blocked item. Checked each
one directly against the actual new files:

| Blocked item | Resolved by the new ABI package? | Detail |
|---|---|---|
| Raw order-book (PATRICIA tree) decoding | **Yes** | `orderbook.ts` has real, generated offsets: `ARENA_NODES_OFFSET`, `ANY_NODE_SIZE` (88), `TAG_INNER`/`TAG_LEAF`, and per-field offsets for both `InnerNode` and `LeafNode` (side, quantity, expires_at, peg_limit, price_or_offset, sequence). This is exactly what `lib/open-orders.ts`'s `unimplementedOpenOrdersAdapter` is waiting on. |
| Per-kind raw event decoding | **Partially** | `events.ts` gives `EVENT_KIND` (same discriminator table `workers/src/event-decoder.ts` already uses) and `EVENT_HEADER_SIZE`/`EVENT_PAYLOAD_SIZE` -- but note `EVENT_PAYLOAD_SIZE` here is **88 bytes**, not the 48 bytes `workers/src/event-decoder.ts` currently assumes. That's a real discrepancy to resolve, not just a rename -- see "Open questions" below. It does NOT give a per-kind payload field layout (e.g. what bytes within the 88-byte payload mean for `OrderFilled` specifically) -- that would need to come from wherever `registry.rs` (also added in this ABI commit range, 129 lines, not yet read in depth) documents it. |
| Raw oracle payload decoding | **No** | `oracle.ts` only adds `MARKET_SESSION` and a `SESSION_TO_MODE` mapping (Pyth Pro's market-session field to the on-chain `MarketMode`). It does not decode a raw oracle account/payload at all. `lib/oracle-safety.ts`'s existing boundary (verified header fields + verified event kind names, never the event's payload body) is unaffected either way. |
| Canonical ABI migration (this frontend's own `clients/stockstream/src/index.ts` vs. the new `abi/` package) | **Not done, needs a decision** | `accounts.ts::decodeMarketHeader` and `sessions.ts::decodeTradingSession` overlap heavily with hand-written decoders this frontend already has in `clients/stockstream/src/index.ts` (`decodeMarketState`, the trading-session decode logic) and in `workers/src/market-state.ts`. Field names differ (e.g. `maximumExposure` vs. this branch's `maximumExposure`/`maxExposure` naming), and **the session discriminator is different**: the new package uses `"STKSES02"` (`sessions.ts`), and this branch's session-reading code path should be checked against whichever discriminator/offsets it currently assumes before trusting it still matches. This needs an explicit reconciliation pass, not a blind swap. |
| Live relayer submission | No change | Unrelated to the ABI package. Still requires the main agent's authenticated relayer to be live and reachable from a real Devnet environment. |
| Live Devnable browser acceptance | No change | Same -- an environment/infrastructure blocker, not an ABI one. |

## Open questions to resolve BEFORE writing any decode code against this package

Do not start implementing against `clients/stockstream/src/abi/` without
resolving these -- guessing past them would be exactly the kind of
unverified-layout decoding this whole branch has been careful to avoid:

1. **Event payload size mismatch.** `workers/src/event-decoder.ts` (this
   branch's actively-used decoder) assumes a 48-byte category-specific
   payload after a 52-byte header (`EVENT_HEADER_SIZE = 52`,
   `EVENT_PAYLOAD_SIZE = 48` there). The new `abi/events.ts` says
   `EVENT_HEADER_SIZE = 12`, `EVENT_PAYLOAD_SIZE = 88`. These are NOT the
   same framing -- header size alone differs by 4x. Read
   `programs/stockstream/src/events.rs`'s actual `encode_event` (both
   branches' current copies, they may have diverged) directly before
   assuming either number is still correct; do not average them or guess.
2. **`registry.rs` (129 new lines, not yet read as part of this
   checklist)** may be where per-kind payload field layouts actually live.
   Read it in full before assuming the payload is still opaque.
3. **Session discriminator/offset reconciliation.** Confirm whether this
   branch's current session-reading path
   (`clients/stockstream/src/index.ts`, `lib/session-trading.ts`,
   `features/sessions/use-trading-session.ts`) already matches
   `"STKSES02"`/`sessions.ts`'s offsets, or predates it. If it predates
   it, every already-shipped session-authorize/revoke/nonce-tracking flow
   in this branch needs to be re-verified against the new layout before
   trusting it in front of a real program.
4. **`book.rs`'s 7-line change** (part of commit `831935d`) may have
   altered the arena layout slightly to make it generator-friendly --
   diff `programs/stockstream/src/book.rs` between the merge-base and
   `core-auth-sprint` directly rather than assuming the orderbook.ts
   offsets apply to an unmodified `book.rs`.

## Rebase procedure

Run from a worktree on `stockstream/frontend-product` (this branch), with
a clean working tree (`git status` first -- stash or commit anything
outstanding).

```sh
git fetch origin  # or wherever core-auth-sprint actually lives for you
git rebase stockstream/core-auth-sprint
```

Expected outcome: applies cleanly except for one small, easily-resolved
conflict in `package.json` (and its lockfile). The only overlapping hunk
is the `scripts` block growing on both sides:

```diff
     "test:watch": "vitest",
-    "test:browser": "playwright test"
+    "test:browser": "playwright test",
+    "test:browser:production": "playwright test --config=playwright.production.config.ts"
+    "generate:stockstream-abi": "...",
+    "check:stockstream-abi": "..."
```

Resolution: keep both sides' additions (this branch's `test:browser*`
entries plus `core-auth-sprint`'s `generate/check:stockstream-abi`
entries), then run `npm install` to regenerate a consistent
`package-lock.json` rather than hand-editing the lockfile. Re-run
`npx tsc --noEmit`, `npx eslint .`, `npm test`, and `npm run test:browser`
after the rebase completes, per this branch's established verification
habit (every commit on this branch was gated on all three passing clean).

## Implementation checklist, once the open questions above are resolved

In dependency order -- later items assume earlier ones are done:

1. Resolve the four open questions above by reading the actual current
   Rust source, not by guessing from the two partially-conflicting sets
   of TS constants.
2. Reconcile `clients/stockstream/src/index.ts`'s existing decoders
   against `clients/stockstream/src/abi/{accounts,sessions}.ts` field-by-
   field. Decide whether to adopt the new `abi/` package as the source of
   truth and update this branch's callers, or keep the existing decoders
   if they're confirmed still correct -- do not run both side by side
   long-term, that's the "two places to drift apart" problem this branch
   has avoided elsewhere (see `lib/execution-status.ts`'s module doc for
   the same principle applied to indexer state).
3. Implement a real `OpenOrdersAdapter` (replacing
   `lib/open-orders.ts`'s `unimplementedOpenOrdersAdapter`) using
   `abi/orderbook.ts`'s verified offsets to walk the PATRICIA tree arena
   and decode `LeafNode`s into `OpenOrderView`s. `features/orders/
   open-orders-panel.tsx` and `use-open-orders.ts` need no changes --
   they were built against the adapter interface specifically so this
   swap is the only change required.
4. If question 1/2 resolve favorably, extend
   `workers/src/event-decoder.ts` (main-agent-owned) to decode per-kind
   payload fields; on the frontend side, extend
   `lib/activity-view-model.ts`'s `toActivityRow` to surface real decoded
   fields instead of (or alongside) `ACTIVITY_DETAIL_UNAVAILABLE`.
5. Re-run this branch's full test suite (`npm test`, `npm run
   test:browser`, `npm run test:browser:production`) plus the accessibility
   scan (`tests/browser/accessibility.spec.ts`) after wiring in real data --
   several tests (`lib/open-orders.test.ts`, the Activity feed tests)
   assert the CURRENT honest-unavailable behavior and will need updating
   to assert real decoded values instead, not just pass incidentally.
6. Only after 1-5: revisit the two remaining blocked items (live relayer
   submission, live Devnet browser acceptance) -- these need a reachable
   authenticated relayer and real Devnet RPC access, which this checklist
   cannot resolve on its own.

## What this checklist deliberately does not do

It does not implement any of the above. Per this branch's standing
instructions, raw order-book/event/oracle-payload decoding stays
unimplemented here until the open questions above are actually resolved
against the real Rust source -- writing decode code against numbers that
might be stale (see the event-payload-size discrepancy) would be exactly
the kind of unverified-layout guess this branch has been built to avoid
everywhere else.
