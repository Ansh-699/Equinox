# ABI handoff checklist and rebase procedure

**Status as of this writing: a canonical ABI package already exists on
`equinox/core-auth-sprint` but has not been merged into this branch
(`equinox/frontend-product`) or acted on. Separately, this branch's
own SDK (`clients/equinox/src/index.ts`) already has a complete,
tested per-kind event/oracle payload decoder that predates this session
and has never been wired into any UI.** All four of this document's
original open questions are now resolved (see the "Resolved: ..."
sections below); the only thing genuinely left open is a decision, not
an investigation. This document exists so that whoever picks this up
next — human or agent — doesn't have to re-derive any of this from
scratch.

## What actually changed (verified by reading the commits directly, not assumed)

`equinox/core-auth-sprint` is 12 commits ahead of the point this branch
forked from (merge-base `bea420a`). Three of those commits are the ABI
package:

- `1aea6db` "publish canonical Equinox ABI package" — adds
  `clients/equinox/src/abi/{accounts,constants,errors,events,index,
  instructions,oracle,orderbook,pda,sessions}.ts` and `layout.json`.
- `831935d` "add Rust ABI manifest generator with CI parity test" — adds
  `programs/equinox/tests/abi_manifest.rs`, a small `book.rs` change,
  and the generated `layout.json` the TS constants are transcribed from.
- `64117c1` "add generate/check ABI parity npm scripts" — adds
  `npm run generate:equinox-abi` / `npm run check:equinox-abi`,
  which regenerate `layout.json` from the Rust source via `cargo test`
  and diff it against the checked-in copy. This is a real, CI-enforceable
  parity gate, not a hand-maintained set of constants that can silently
  drift from the program.

**Verified: this is purely additive.** `git diff --name-only` between the
merge-base and each branch's tip shows exactly two overlapping files
between what this branch changed and what `core-auth-sprint` changed:
`package.json` and `package-lock.json` (see "Rebase procedure" below for
the exact, trivial diff). Nothing in `clients/equinox/src/index.ts`
(the module every frontend file in this branch actually imports from) was
touched by the ABI package commits — the new layout lives entirely under
a new `clients/equinox/src/abi/` directory. A rebase of this branch
onto current `core-auth-sprint` should apply cleanly with no code
conflicts.

## What this unblocks, precisely — and what it does NOT

Do not assume the ABI package resolves every blocked item. Checked each
one directly against the actual new files:

| Blocked item | Resolved by the new ABI package? | Detail |
|---|---|---|
| Raw order-book (PATRICIA tree) decoding | **Yes** | `orderbook.ts` has real, generated offsets: `ARENA_NODES_OFFSET`, `ANY_NODE_SIZE` (88), `TAG_INNER`/`TAG_LEAF`, and per-field offsets for both `InnerNode` and `LeafNode` (side, quantity, expires_at, peg_limit, price_or_offset, sequence). The V3 Worker aggregate adapter now consumes the validated page/tree projection; `unimplementedOpenOrdersAdapter` is retained only for explicit V2/unknown-version fallback. |
| Per-kind raw event decoding | **Already resolved on THIS branch, independently of the new ABI package -- see below** | The new `abi/events.ts`'s `EVENT_HEADER_SIZE`/`EVENT_PAYLOAD_SIZE` (12/88) are a **verified bug**, not a real discrepancy to reconcile (see "Resolved: the event-payload-size question" below). Separately and more importantly: `clients/equinox/src/index.ts` (unchanged between the two branches, i.e. already on THIS branch) already has a complete, unit-tested set of per-kind payload decoders (`decodeOrderPayload`, `decodeFillPayload`, `decodePositionPayload`, `decodeFundingPayload`, `decodeLiquidationPayload`, `decodeOraclePayload`, `decodeDelegationPayload`, `decodeSessionPayload`, `decodeRegistryPayload`, `decodeReconciliationPayload`), matching `programs/equinox/src/events.rs`'s real `payload_*` builder functions byte-for-byte, with real assertions in `clients/equinox/src/index.test.ts`. |
| Raw oracle payload decoding | **The decoder already exists and is tested on THIS branch (`decodeOraclePayload`) -- never wired into any UI** | `clients/equinox/src/index.ts::decodeOraclePayload` decodes `events::payload_oracle`'s real fields (price, exponent, confidence, session) and is exercised in `index.test.ts`. `lib/oracle-safety.ts` was deliberately built to never call it, per the standing "hold" instruction -- see below for why this is flagged as a decision point rather than acted on unilaterally. |
| Canonical ABI migration (this frontend's own `clients/equinox/src/index.ts` vs. the new `abi/` package) | **Verified compatible already -- no migration needed for market/session decoding** | `accounts.ts::decodeMarketHeader` and `sessions.ts::decodeTradingSession` were checked field-by-field against this branch's existing `decodeMarketState`/`decodeTradingSession`: identical offsets throughout (see the resolved session-discriminator question below). The only genuinely NEW layout the `abi/` package provides that this branch didn't already have is the order book (`orderbook.ts`) -- that's the real, and only, migration item. |
| Live relayer submission | No change | Unrelated to the ABI package. Still requires the main agent's authenticated relayer to be live and reachable from a real Devnet environment. |
| Live Devnable browser acceptance | No change | Same -- an environment/infrastructure blocker, not an ABI one. |

## Resolved: the event-payload-size question (was an open question, now answered)

Read `programs/equinox/src/events.rs` directly on `core-auth-sprint`
(the real, current, authoritative source -- not either TS file). It
defines `EVENT_PAYLOAD_SIZE = 48` and `EventHeader` as `discriminator(u16)
+ abi_version(u8) + reserved(u8) + sequence(u64) + market([u8;32]) +
timestamp(u64)`, which is exactly **52 bytes** (`size_of::<EventHeader>()`
asserted at compile time in the same file). This matches
`workers/src/event-decoder.ts`'s 52/48 exactly and matches this branch's
own `clients/equinox/src/index.ts` (`EVENT_HEADER_SIZE`/
`EVENT_PAYLOAD_SIZE` there, unchanged between branches).

**The new `abi/events.ts` and `abi_manifest.rs`'s `EVENT_HEADER_SIZE = 12`,
`EVENT_PAYLOAD_SIZE = 88` are wrong** -- not a newer/different valid
framing, a bug. Traced why the generator's own "CI parity" test doesn't
catch it: `abi_manifest.rs`'s `manifest_constants_are_consistent` test
only asserts the *total* `EVENT_SIZE` against `equinox::events::
EVENT_SIZE` (`assert_eq!(EVENT_SIZE, equinox::events::EVENT_SIZE)`)
-- it never independently checks `EVENT_HEADER_SIZE` or
`EVENT_PAYLOAD_SIZE` against the real constants. `12 + 88 = 100` and
`52 + 48 = 100` are both correct as *totals*, so the wrong header/payload
split passes the existing parity gate silently. This is a real gap in
that CI check, not something for this branch to route around -- worth
reporting upstream rather than working past it here.

**Practical consequence:** never use `abi/events.ts`'s
`EVENT_HEADER_SIZE`/`EVENT_PAYLOAD_SIZE` if/when this branch rebases onto
`core-auth-sprint`. Keep using the already-correct 52/48 split
(`workers/src/event-decoder.ts` and `clients/equinox/src/index.ts`
already agree on it) until the generator itself is fixed on that branch.

## Resolved: per-kind event payload decoding already exists on THIS branch, untouched by the ABI package, and has never been wired to any UI

This is the single most important finding in this document. Reading
`programs/equinox/src/events.rs` in full (both branches -- it's
unchanged between them) shows real, documented, byte-exact payload
builder functions: `payload_order`, `payload_fill`, `payload_position`,
`payload_funding`, `payload_liquidation`, `payload_oracle`,
`payload_delegation`, `payload_session`, `payload_registry`,
`payload_reconciliation`, each with an exact byte-offset doc comment.

**`clients/equinox/src/index.ts` already has a matching decoder for
every one of them** -- `decodeOrderPayload`, `decodeFillPayload`,
`decodePositionPayload`, `decodeFundingPayload`,
`decodeLiquidationPayload`, `decodeOraclePayload`,
`decodeDelegationPayload`, `decodeSessionPayload`,
`decodeRegistryPayload`, `decodeReconciliationPayload` -- plus
`decodeEquinoxEvent`, which decodes the 52-byte header and hands back
the raw 48-byte payload for one of the above to interpret by kind. These
are **not new, not experimental, and not part of the ABI package** --
they predate this session's fork point entirely, and
`clients/equinox/src/index.test.ts` already exercises several of them
(`decodeEquinoxEvent`, `decodeFillPayload`, `decodeSeatAmountPayload`)
with real fixture bytes.

**Verified nobody in this app actually calls them**: `grep -rl` for every
one of those function names across `app/`, `features/`, `components/`,
`lib/` (excluding the SDK module and its own test file) returns nothing.
This entire decoder surface has been sitting in the codebase, correct and
tested, completely unused by both `workers/src/event-decoder.ts` (which
independently reimplements only the header decode, never the per-kind
payload) and by this branch's own `lib/oracle-safety.ts` /
`lib/activity-view-model.ts` (which were deliberately built to say
"unavailable" rather than decode a payload body).

**Why this branch never used it, and why that's flagged here rather than
just fixed:** the standing instruction this branch was built under holds
"per-kind raw event decoding" and "exact raw oracle payload decoding" as
two of six items to leave to a main-agent handoff. That instruction was
followed literally and in good faith throughout -- `lib/oracle-safety.ts`
and `lib/activity-view-model.ts`'s module docs both explicitly reason
about *why* the payload body stays undecoded. But the premise behind
holding those two items -- that no verified layout exists yet -- turns
out to be incomplete: a verified, tested layout already existed in this
same branch's own SDK the entire time; it was simply never connected to
the UI. Whether to now wire `decodeOraclePayload`/`decodeOrderPayload`/
etc. into `lib/oracle-safety.ts` and `lib/activity-view-model.ts` is a
real decision, not an obvious "yes" -- these decoders have never been
exercised against a live devnet transaction, only fixture bytes, and
wiring them changes what the UI claims to know. That decision was
explicitly left to whoever reads this next, rather than made
unilaterally by continuing past the standing "hold."

## Further open questions to resolve BEFORE relying on the NEW `abi/` package specifically

Do not start implementing against `clients/equinox/src/abi/` without
resolving these -- guessing past them would be exactly the kind of
unverified-layout decoding this whole branch has been careful to avoid:

1. **`registry.rs`, read in full**: it defines exchange/instrument
   registry logic (config updates, instrument registration, vault account
   creation) and imports the payload *builder* helpers above by name --
   it is not itself a payload-layout source; the layouts are in
   `events.rs` (see above, now resolved).
2. ~~Session discriminator/offset reconciliation.~~ **Resolved: already
   matches, no action needed.** `clients/equinox/src/index.ts::
   decodeTradingSession` (unchanged between branches) already checks
   `discriminator !== "STKSES02"` and every single field offset (owner
   12-44, sessionSigner 44-76, targetProgram 76-108, market 108-140,
   traderSeatIndex 140, createdAt 142, expiresAt 150, actions 158,
   maxOrderNotional 159, maxCumulativeNotional 167,
   consumedCumulativeNotional 175, maxExposure 183, maxOpenOrders 199,
   nextExpectedNonce 201, lastActionTimestamp 209, sessionGeneration 217)
   is byte-identical to the new `abi/sessions.ts::decodeTradingSession`.
   Every already-shipped session-authorize/revoke/nonce-tracking flow in
   this branch (`lib/session-trading.ts`,
   `features/sessions/use-trading-session.ts`) is safe as-is.
3. ~~`book.rs`'s 7-line change~~ **Resolved: purely cosmetic, no layout
   change.** Diffed directly: it only changes `TAG_INNER`/`TAG_LEAF`/
   `TAG_FREE` from private to `pub` and adds one new `pub const
   ANY_NODE_SIZE: usize = 88` (already asserted equal to
   `size_of::<AnyNode>()` elsewhere in the same file). No struct field, no
   offset, no size actually changed. `orderbook.ts`'s offsets apply
   cleanly.

## Rebase procedure

Run from a worktree on `equinox/frontend-product` (this branch), with
a clean working tree (`git status` first -- stash or commit anything
outstanding).

```sh
git fetch origin  # or wherever core-auth-sprint actually lives for you
git rebase equinox/core-auth-sprint
```

Expected outcome: applies cleanly except for one small, easily-resolved
conflict in `package.json` (and its lockfile). The only overlapping hunk
is the `scripts` block growing on both sides:

```diff
     "test:watch": "vitest",
-    "test:browser": "playwright test"
+    "test:browser": "playwright test",
+    "test:browser:production": "playwright test --config=playwright.production.config.ts"
+    "generate:equinox-abi": "...",
+    "check:equinox-abi": "..."
```

Resolution: keep both sides' additions (this branch's `test:browser*`
entries plus `core-auth-sprint`'s `generate/check:equinox-abi`
entries), then run `npm install` to regenerate a consistent
`package-lock.json` rather than hand-editing the lockfile. Re-run
`npx tsc --noEmit`, `npx eslint .`, `npm test`, and `npm run test:browser`
after the rebase completes, per this branch's established verification
habit (every commit on this branch was gated on all three passing clean).

## Implementation checklist

All four original open questions above are now resolved (three
confirmed compatible/no-op, one confirmed a bug to avoid). What's left
is implementation work and one real decision, in dependency order:

1. **Decision point, not implementation**: whether to wire
   `clients/equinox/src/index.ts`'s already-existing, already-tested
   per-kind decoders (`decodeOraclePayload`, `decodeOrderPayload`,
   `decodeFillPayload`, etc.) into `lib/oracle-safety.ts` and
   `lib/activity-view-model.ts`. This is flagged, not decided, in this
   document -- see the "Resolved: per-kind event payload decoding..."
   section above for why.
2. **Completed in the current V3 path:** the Worker validates the paged
   Patricia projection and `lib/open-orders.ts`'s
   `createV3OpenOrdersAdapter` turns the aggregate into `OpenOrderView`s.
   `features/orders/open-orders-panel.tsx` and `use-open-orders.ts` remain
   unchanged because they consume the adapter interface. The old
   `unimplementedOpenOrdersAdapter` is intentionally V2/unknown-version
   fallback only.
3. If (1) is decided yes: extend `lib/activity-view-model.ts`'s
   `toActivityRow` to call the existing per-kind decoders and surface
   real fields instead of (or alongside) `ACTIVITY_DETAIL_UNAVAILABLE`,
   and extend `lib/oracle-safety.ts` to read `decodeOraclePayload`'s
   fields directly rather than only the account header + event kind name.
   `workers/src/event-decoder.ts` (main-agent-owned, the live stream's
   own decoder) would also need the same per-kind decode added
   server-side for the WebSocket payload to carry the decoded fields at
   all -- today it forwards only the raw payload bytes.
4. Re-run this branch's full test suite (`npm test`, `npm run
   test:browser`, `npm run test:browser:production`) plus the accessibility
   scan (`tests/browser/accessibility.spec.ts`) after wiring in real data --
   several tests (`lib/open-orders.test.ts`, the Activity feed tests)
   assert the CURRENT honest-unavailable behavior and will need updating
   to assert real decoded values instead, not just pass incidentally.
5. Only after 1-4: revisit the two remaining blocked items (live relayer
   submission, live Devnet browser acceptance) -- these need a reachable
   authenticated relayer and real Devnet RPC access, which this checklist
   cannot resolve on its own.

## What this checklist deliberately does not do

It does not implement any of the above, and does not rebase this branch
onto `core-auth-sprint`. Per this branch's standing instructions, raw
order-book decoding, per-kind event decoding, oracle-payload decoding,
and the canonical ABI migration are four of six items held for a
main-agent handoff decision rather than acted on unilaterally --
including the per-kind event and oracle-payload decoders this document
found already exist, tested, in this branch's own SDK. Investigating
and documenting what's actually true (verified byte layouts, a real bug
in a sibling branch's CI gate, existing-but-unwired decode capability)
is not the same action as deciding to wire it into production UI
against a standing "hold," and this document treats that distinction as
real.
