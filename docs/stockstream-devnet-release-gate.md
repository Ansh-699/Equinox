# StockStream Devnet Release Gate

Status: NOT READY FOR DEVNET DEPLOYMENT

This gate records standalone StockStream evidence only. No devnet deployment
or external protocol integration was performed in this sprint.

## Passed Foundation Gates

| Gate | Evidence | Status |
| --- | --- | --- |
| Independent workspace | Root Cargo workspace contains only `programs/stockstream`. | PASS |
| Program identity | `6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU` is used by the Rust program and client constants. | PASS |
| Pinocchio version | Cargo resolves `pinocchio v0.11.2`. | PASS |
| Native verification | Formatting, check, 27 debug tests, and 27 release tests completed successfully. | PASS |
| Market-state layout | Versioned `MarketState`, two independent 90,640-byte side arenas, and 88-byte tagged node ABI assertions compile. | PASS |
| PATRICIA arena | Shared per-side allocator, two roots, branch compression, expiry caches, free-list reuse, and integrity validation are tested. | PASS |
| Deterministic matching | Bounded fixed/pegged matching, cross-tree FIFO, post-only, IOC, partial fills, self-cancel, invalid cleanup, and unavailable-price suspension tests pass. | PASS |
| SBF verification | `cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint` completed successfully. | PASS |
| Artifact evidence | `target/deploy/stockstream.so`; SHA-256 `228aa1c9f1d1ac45494f9a118e3efced1695cc05b169c9f14b6cadcd743c5314`; 49,232 bytes. | PASS |
| Persistent layout and risk primitives | `MarketState`/`TraderSeat` size assertions, seat lifecycle, position transitions, PnL, margin, fees, funding math, liquidation eligibility, and overflow tests pass. | PASS |
| Typed client and vectors | 4 Vitest client tests and 1 Rust golden-vector test pass; no transaction submission is implemented. | PASS |
| Privy authentication boundary | 4 server session tests pass; current Privy server SDK verification is used and raw tokens are not stored. | PASS |
| Account-backed settlement progress | 2 serialized account tests pass for crossing settlement and unauthorized-cancel byte preservation. | IN PROGRESS |

## Current Program Boundary

The program implements strict instruction decoding, program-ID consistency
checks, market-account layout validation, seat lifecycle validation, and
production guards that reject trading without a verified oracle. The typed
client constructs unsigned instructions and previews only. The authenticated
dashboard shows local-build and integration status without fabricated balances,
fills, signatures, or latency.

## Devnet Blockers

- Full persistent place/cancel/match settlement and atomic rollback coverage at the account-instruction boundary.
- Production session persistence and multi-instance revocation storage.
- Asset custody and token-program validation.
- Verified Pyth oracle integration and oracle-driven production price path.
- MagicBlock delegation/session lifecycle.
- Browser transaction signing and live submission.
- Program-test coverage using a local validator.
- Security review of the expanded instruction surface.
- Explicit deployment transaction and post-deploy binary/program-ID verification.

## Gate 1 Status

**MVP Gate 1: PASS.** The scratch-backed, plan-driven account settlement path
is exercised by 45 debug and 45 release tests. The MVP evidence covers
full/partial crossing settlement, IOC remainder removal, crossing post-only
byte preservation, exact cancellation reserve release, stale maker and market
snapshot rejection, event-ring wraparound, funding and healthy-liquidation
boundaries. Successful instructions clear the per-seat scratch account.

The verified artifact is
`7bfad1e46257677bdc7ee7ec8fe0dfbab581df6eda2b968328a8c639f12e5377`
(`121,952` bytes). `cargo build-sbf --features bpf-entrypoint` completed with
no stack-frame diagnostic.

**Production hardening: PENDING. Audit: PENDING. Production approval: NO.**
Runtime rollback proof, exhaustive settlement permutations, broad randomized
economic testing, fuzzing, and independent review remain required before any
production claim.

The detailed toolchain, artifact, and test evidence is recorded in
`docs/stockstream-build-record.md`.

## Generic Market Isolation

**Unit tested.** The exchange/instrument/perp-market registry is wired into the
Rust dispatcher, TypeScript client and market-data registry. AAPL-PERP,
TSLA-PERP and NVDA-PERP fixtures have independent market-scoped addresses and
remain `live: false` until their deployment, mint and oracle configuration are
verified.

Runtime loading, token CPI, signed Pyth updates, MagicBlock ER execution,
Privy login and devnet deployment remain unverified until the external
toolchain, credentials and funded network are available.

## Post-Gate Integration Wiring

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Pinocchio dispatch | IMPLEMENTED | Custody, oracle, delegation, commit, callback and session discriminators are decoded and dispatched. |
| Custody CPI boundary | IMPLEMENTED / RUNTIME BLOCKED | SPL Token transfer builders and collateral reconciliation are wired; actual CPI execution awaits the compatible SBPF runtime. |
| Persistent authentication | IMPLEMENTED / CREDENTIAL BLOCKED | Next routes use the D1 store; live Privy exchange requires `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`. |
| Frontend transactions | IMPLEMENTED / DEVNET UNVERIFIED | Dashboard constructs lifecycle instructions and injected signing transports; no signatures are fabricated. |
| Pyth keeper | UNIT TESTED / CREDENTIAL BLOCKED | Server-only keeper and rejection boundary exist; live signed AAPL verification requires `PYTH_PRO_API_KEY` and a verified feed catalog result. |
| MagicBlock | UNIT TESTED / RUNTIME BLOCKED | Account-cluster validation and commit encodings exist; ER execution is not claimed. |
| Gate 2 | BLOCKED — TOOLCHAIN | Local SBPF runtime mismatch remains documented in `docs/sbpf-compatibility.md`. |

## Code-Completion Evidence

The generic registry now has real update/suspend/risk/market-transition
dispatch variants, and the TypeScript constructors use matching discriminators.
The Worker has durable protocol projection tables, sequence-aware Durable
Object snapshots, contiguous-cursor reconciliation helpers, keeper lease and
idempotency primitives, and scheduled retention/lease cleanup. The reusable
protocol service composes account instructions over injected L1 and Magic
Router transports without fabricating signatures.

Current source SBF: SHA-256
`f821f560499508efa26d85f025910681466f524a4665b54abd6229d96cdeba60`,
`151,608` bytes. This is compiled evidence only; runtime, CPI, ER and live
external integrations are not verified.

## Deferred Production Hardening

The hackathon MVP gate intentionally defers the exhaustive settlement
permutation matrix, large randomized economic model, fuzzing, complete
liquidation/event-ring matrices, long-duration ER failure simulation, and an
independent audit. These remain required for production approval. The current
artifact must not be described as production-ready or audited.

## Status Correction (2026-09-16)

The older “Code-Completion Evidence” heading is historical wording, not a
global completion claim. The source has meaningful local coverage for
scratch-backed settlement, registry oracle configuration, session account
binding, D1 leases/idempotency/cursors, and Durable Object gap recovery.
It does not yet contain real onchain MagicBlock delegation/commit CPIs, live
Pyth Pro signed payload acceptance, runtime SPL CPI evidence, complete session
cumulative-notional/replay consumption, or a complete external Solana/ER
indexer and keeper fleet.

**Hardening pending. Audit pending. Production not approved.**

## Priority 4 Status Correction (2026-09-16)

Custody, vault accounting, withdrawal health, fees, insurance and
reconciliation are now **code implemented, unit tested, SBF compiled,
runtime unverified** on top of the existing (not a parallel) custody model.
Two real integration defects were found and fixed in this pass (see
`docs/custody.md` and `docs/stockstream-build-record.md`): a stale
delegation-status byte check that would have blocked withdrawals for a
`Restored` market, and a held token-account borrow across the SPL Transfer
CPI that would have failed **every** deposit and withdrawal on a real
cluster (not only in tests) -- undetected until this priority added the
first end-to-end custody tests.

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| Vault initialization/config | IMPLEMENTED / UNIT TESTED | Canonical PDA vault + vault-authority model (Model A), legacy-SPL-only, exact-decimals; duplicate-init and wrong-authority rejected. |
| Deposit/withdrawal | IMPLEMENTED / UNIT TESTED / RUNTIME BLOCKED | Full pre-CPI validation and post-CPI ledger update tested; CPI itself is a no-op off SBF (`docs/magicblock.md`). |
| Fee/insurance ledgers | IMPLEMENTED / UNIT TESTED | Automatic fee crediting from real fills/liquidations; ledger transfer and withdrawal with authority separation (market vs. emergency authority); bad-debt record/resolve. |
| Reconciliation | IMPLEMENTED / UNIT TESTED | Permissionless recompute; auto-pause and withdrawal block on detected deficit; escalation to `RecoveryRequired` on a persisted deficit; surplus recorded, never auto-assigned. |
| Custody events | IMPLEMENTED / UNIT TESTED | `pinocchio_log`-based program-log events (not a binary ring buffer, to avoid growing `MARKET_ACCOUNT_SIZE`); TypeScript decoder and golden vectors. |

**Hardening pending. Audit pending. Production not approved.**

## Priority 5/6 Status: Durable Indexer, Private Projections, Keepers (2026-09-17)

`MARKET_VERSION` bumped to `2` for the now-permanent custody ledger fields
(`docs/stockstream-build-record.md`'s Layout Formalization entry). Worker-
side indexing, reconciliation and private-projection infrastructure is now
substantially real, not aspirational:

| Area | Status | Evidence / limitation |
| --- | --- | --- |
| L1/ER WebSocket transports | IMPLEMENTED / UNIT TESTED | Real Solana pubsub protocol (`logsSubscribe`/`accountSubscribe`/`signatureSubscribe`), bounded reconnect, subscription restoration, stale-connection detection. NOT wired into the scheduled ingestion loop yet (HTTP polling is the live path). |
| Event decoding | IMPLEMENTED / UNIT TESTED / PARTIAL COVERAGE | Custody events only -- decoded from both live log notifications and `getTransaction` results. No other event type (order/fill/funding/liquidation/oracle/delegation/session) is logged by the Rust program yet, so there is nothing else to decode. |
| Durable ingestion + gap recovery | IMPLEMENTED / UNIT TESTED (real D1 + real Durable Object) | Concrete `AccountSnapshotFetcher` backs gap-triggered resnapshot end to end, not just an interface. |
| ER/L1 execution-status reconciliation | IMPLEMENTED / UNIT TESTED / INDEXER-DISPLAY-ONLY | Pure state-machine model for UI display; NOT wired to live on-chain commit data; explicitly not the security boundary (on-chain `DelegationStatus` is). |
| Private trader projections | IMPLEMENTED / UNIT TESTED | Verified filtered subscriptions over the existing `MarketStream` Durable Object; on-chain seat-ownership check at issuance; public/private delivery structurally separated. |
| Scheduled ingestion loop | IMPLEMENTED / UNIT TESTED | Independent fenced keeper lease alongside (not instead of) cleanup. |
| Dead-letter handling | IMPLEMENTED / UNIT TESTED | First code ever to use the previously-inert `dead_letters` table; bounded-attempt give-up; `GET /v1/health/keepers`. |
| Signing keeper jobs (Pyth push, commit scheduling, funding settlement) | NOT IMPLEMENTED | No wallet/key-management infrastructure exists in the Worker yet -- this is the next real blocker for Priority 6. |

Worker test count: `66 passed; 0 failed` (real Miniflare/D1/Durable-Object
environment, not plain JS fakes), up from `21`.

**Hardening pending. Audit pending. Production not approved.**
