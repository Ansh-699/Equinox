# Equinox Program Build Record

Date: 2026-09-15
Scope: standalone program-foundation milestone only

| Item | Recorded value |
| --- | --- |
| Rust | `rustc 1.98.0 (88d9e12ae 2026-08-18)` |
| Solana / Agave CLI | `solana-cli 4.2.1 (src:75f9b5b4; feat:21b0d33a, client:Agave)` |
| Pinocchio | `0.11.2` exactly |
| Equinox program ID | `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET` |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `c298700f1dc22690e9988bc59e8b8c8bc76dc70c6e321105cc19400deb052e79` |

## Phase 1 Verification Results

```text
$ cargo fmt --check
exit 0

$ cargo check -p equinox
Finished `dev` profile [unoptimized + debuginfo]

$ cargo test -p equinox
7 integration tests passed; 0 failed

$ NO_DNA=1 cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint
Finished `release` profile [optimized]
```

The artifact was built from the standalone `equinox` crate. The deployment
output directory contains only `equinox.so`; no generated default keypair is
retained there. The program keypair used for the recorded program ID is kept
outside version control in `.keys/equinox-program-keypair.json`.

## Phase 2 Verification Results

Scope: market-state layouts, two fixed-capacity PATRICIA arenas, oracle-pegged
order evaluation, deterministic bounded matching, and native tests only.

| Item | Recorded value |
| --- | --- |
| Pinocchio | `0.11.2` exactly |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `2f05285270666a4431fab314e5f9061d8d0170583681214637c7059ff8eb3623` |
| SBF size | `35,824` bytes |
| Native tests | `20 passed; 0 failed` |
| Release tests | `20 passed; 0 failed` |
| Compute-unit measurement | Not available: no local-validator instruction benchmark was run in this scope. |

```text
$ cargo fmt --check
exit 0

$ cargo check -p equinox
Finished `dev` profile [unoptimized + debuginfo]

$ cargo test -p equinox
13 order-book tests + 7 program-boundary tests passed; 0 failed

$ cargo test -p equinox --release
13 order-book tests + 7 program-boundary tests passed; 0 failed

$ NO_DNA=1 cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint
Finished `release` profile [optimized]
```

The Phase 2 SBF binary retains the arena validator and bounded matcher through
SBF-only `#[used]` function references. This prevents the optimizer from
discarding the newly implemented program logic before Phase 3 account-instruction
wiring exists.

## Core/Auth Sprint Verification Results

Scope: persistent market and trader-seat layouts, checked risk primitives,
program instruction boundaries, typed client constructors/decoders, Privy token
verification with hashed application sessions, and truthful authenticated UI
status. Pyth, USDC custody, MagicBlock, live submission, and deployment remain
out of scope.

| Item | Recorded value |
| --- | --- |
| MarketState header | `512` bytes |
| TraderSeat | `256` bytes |
| Market account | `222,752` bytes |
| Arena regions | bid `512..91,152`; ask `91,152..181,792` |
| Trader seats | `181,792..214,560`, 128 x 256 bytes |
| Fill event region | `214,560..222,752`, 128 x 64 bytes |
| Program tests | 27 passed debug; 27 passed release |
| Application/client tests | 10 passed |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `228aa1c9f1d1ac45494f9a118e3efced1695cc05b169c9f14b6cadcd743c5314` |
| SBF size | `49,232` bytes |
| Compute-unit measurement | Not available; no validator benchmark was run. |

```text
$ cargo fmt --check
exit 0
$ cargo check -p equinox
exit 0
$ cargo test -p equinox
27 passed; 0 failed
$ cargo test -p equinox --release
27 passed; 0 failed
$ cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint
exit 0
$ npm run lint
exit 0
$ npx tsc --noEmit
exit 0
$ npm test -- --run
10 passed; 0 failed
```

The browser authentication flow uses `@privy-io/node` token verification and
does not persist raw Privy or application tokens. In this sprint the session
store is process-local for development; production persistence and horizontal
session sharing remain a blocker. The initial production build failed because
`@solana-program/memo` and `@stripe/stripe-js` were absent; after installing
those current Privy peer packages, the final `npm run build` completed
successfully.

## Phase 1 Progress (Gate 1 Open)

The serialized Pinocchio account path now supports market initialization, seat
creation, bounded fixed-price matching, fill-event writes, position updates,
fees, funding settlement, open-interest recomputation, and bounded ownership-
checked cancellation. Two account-backed tests pass, including a crossing
trade and a full-byte unauthorized-cancel check.

| Item | Recorded value |
| --- | --- |
| Rust debug tests | `29 passed; 0 failed` |
| Rust release tests | `29 passed; 0 failed` |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `80928bb8d7a35e79655e7b3a92139fa7fd62ddda7a35d43d7ecdbadac31014c6` |
| SBF size | `95,440` bytes |
| Gate status | `NOT PASSED` |

Gate 1 remains open because complete late-failure account rollback has not
been proven, and the full requested account-level case matrix is still being
implemented. No local-validator or external integration work has started.

## Settlement-Plan Preflight (Executed 2026-09-15)

The current candidate adds a fixed-capacity, no-heap `SettlementPlan` overlay
for immutable maker selection. Plan actions carry the expected handle, tree,
key, owner, and quantity, and are checked before the bounded account matcher
is entered. Expired and permanently invalid opposing leaves are planned for
bounded cleanup; oracle-unavailable pegged leaves remain stored and are
skipped. The current SBF-safe limits are four fills, four invalid removals,
and two expiry removals per instruction.

| Check | Recorded value |
| --- | --- |
| Planner and post-only immutable tests | `2 passed; 0 failed` |
| Rust debug tests | `31 passed; 0 failed` |
| Rust release tests | `31 passed; 0 failed` |
| `cargo fmt --check` | passed |
| `cargo check -p equinox` | passed |
| `cargo build-sbf --features bpf-entrypoint` | passed; no stack diagnostic |
| SBF SHA-256 | `081868a97f4da71a7cea5a226076a03f6fe103db3d6beac98748f094624f9564` |
| SBF size | `117,944` bytes |

This is Gate 1 progress, not a pass. The handler now applies the planned arena
actions and remainder, but complete precomputed maker/taker risk, margin,
funding, event, rollback, and randomized account-model coverage remain.

## Scratch-Backed Settlement Candidate (2026-09-15)

Gate 1 remains **NOT PASSED**. The candidate moves the production plan region
from the handler frame into a per-market/per-seat Equinox-owned settlement
scratch PDA. The canonical seeds are `[b"settlement", market, seat_index_le]`.
The successful order path initializes planning, writes plan/seat/event working
data into scratch, validates the plan, applies planned arena actions, writes
precomputed seat/event results, and clears scratch before returning. There is
no public delayed-plan apply instruction.

| Check | Result |
| --- | --- |
| Scratch header | 266 bytes |
| Encoded `PlannedMatch` region | derived from `size_of::<PlannedMatch>()` |
| Scratch length | derived and bounded below 12 KiB |
| Rust debug tests | `35 passed; 0 failed` |
| Rust release tests | `35 passed; 0 failed` |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `46e25c26417c0ef427be452a75956a17fc7b14cd917f4a11126da5b12375110c` |
| SBF size | `121,248` bytes |
| Stack diagnostic | no frame-overflow warning emitted by `cargo build-sbf` |

The scratch lifecycle is unit-tested, including binding, non-empty reuse,
layout bounds, and PDA separation. The serialized crossing test now initializes
both trader scratch accounts and uses them for each order. The full settlement
matrix, exact reserve ledger, stale-plan mutation cases, and runtime rollback
proof are still required before the gate can be marked passed.

## MVP Account Settlement Gate (Executed 2026-09-15)

MVP Gate 1 passed with scratch-backed planning, validation, application and
clearing in one instruction. The focused account-backed coverage verifies a
partial fill, partial IOC, crossing post-only byte preservation, exact
cancellation reserve release, stale maker and market snapshot rejection, and
event-ring wraparound. Existing state/risk coverage supplies the MVP funding
and healthy-liquidation boundary checks.

| Check | Verified result |
| --- | --- |
| Rust debug tests | `45 passed; 0 failed` |
| Rust release tests | `45 passed; 0 failed` |
| `cargo fmt --check` | passed |
| `cargo check -p equinox` | passed |
| `cargo build-sbf --features bpf-entrypoint` | passed; no stack-frame diagnostic |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `7bfad1e46257677bdc7ee7ec8fe0dfbab581df6eda2b968328a8c639f12e5377` |
| SBF size | `121,952` bytes |
| MVP Gate 1 | `PASS` |
| Production hardening / audit / approval | `PENDING / PENDING / NO` |

The older pre-correction artifacts and candidate hashes in this record are
historical only and are superseded by the artifact above. They must not be
deployed as Equinox evidence.

## Post-Gate-1 Verified Build (Current Source)

The current source rebuild completed after the custody/oracle/lifecycle
boundary work. This artifact is separate from the preserved Gate 1 artifact.

| Check | Result |
| --- | --- |
| Source commit | `2794eca` plus repository cleanup changes |
| `cargo fmt --check` | passed |
| `cargo check -p equinox` | passed |
| Rust debug tests | `45 passed; 0 failed` |
| Rust release tests | `45 passed; 0 failed` |
| SBF build | passed |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `9c31a51030bcd9021a32731f302817442270c740dfe312c84d5ff23bcdd6cef5` |
| SBF size | `118,304` bytes |
| stack diagnostic | no stack-frame diagnostic emitted |

The artifact remains unverified in a runtime because the documented SBPF
toolchain mismatch is unresolved.

## Production Wiring Milestones (2026-09-15)

Milestone A commit `960d1f7` wires custody, oracle, delegation, commit,
undelegation and scoped-session instruction variants into the Pinocchio decoder
and dispatcher. The custody path uses `pinocchio-token v0.7.0` transfer CPI
builders and updates collateral only after CPI success. The typed client has
matching discriminators and account metadata. Rust debug/release tests passed
(`45` each); client/application tests passed (`19` at the milestone).

Milestone B commit `3159c16` wires the Next routes `/api/auth/session`,
`/api/auth/me` and `/api/auth/logout` to the D1-shaped session store. Production
requires a D1 binding; the in-memory adapter is development-only. Session IDs
are hashed, logout is CSRF-protected, expired rows are cleaned and last-use is
updated. Lint, typecheck, tests and production build passed.

Milestone C commit `77f1ff6` connects the dashboard lifecycle controls to typed
instruction constructors and the injected L1 execution boundary. No signature
is fabricated when a transport is unavailable. Twenty TypeScript tests pass,
including the simulation/sign/submit/confirm ordering test.

Milestone D commit `77cfedc` adds the server-only Pyth keeper and health route.
It rotates configured endpoints, retries with backoff, suppresses duplicate or
older payloads, constructs Ed25519 before ConsumeOracleUpdate, and never logs
the API key. Keeper fixtures bring the application total to `22` tests. Live
signed AAPL verification remains blocked by `PYTH_PRO_API_KEY` and an unverified
Pyth Pro feed identifier.

Milestone E adds the pinned Agave installation script and CI workflow. The
script has not been executed locally because Gate 2 runtime execution remains
toolchain-blocked; it is the reproducible path for the serialized harness.

Current SBF artifact from source commit `960d1f7`: SHA-256
`249d8e08411b39b40bc538e090c94586474546b8c38d7279c7c892b9816a5753`, size
`143,656` bytes. This is a post-Gate-1 build and must not be substituted for
the preserved Gate 1 artifact.

## Generic Market Registry Verification (2026-09-15)

The source now exposes fixed-layout `InitializeExchange`,
`RegisterStockInstrument` and `CreatePerpMarket` dispatch variants. Instrument
PDAs use `instrument` plus a stable 32-byte instrument ID; perp-market PDAs use
`perp-market` plus the instrument PDA. The client, worker registry and terminal
use the same market-scoped identifiers. AAPL-PERP, TSLA-PERP and NVDA-PERP are
fixtures with `live: false`; no fixture is presented as a deployed market.

The current source verification added two Rust registry tests and three market
registry Vitest tests. Rust debug and release suites pass with 48 tests each;
the application suite passes 26 tests in 7 files. The final SBF rebuild and
hash are `58eb165bd3f13c63f7ed52c661227a8c398d49c6b1eb425948a38cad325921af`
and `147,344` bytes. The SBF build emitted no stack-frame diagnostic.

## Full Code-Completion Pass (2026-09-16)

This pass adds generic registry lifecycle transitions, the injected protocol
service, persistent-session service tests, Worker projection/indexer/keeper
primitives, Durable Object sequence filtering, migration `0003_protocol_projection.sql`,
and the requested protocol documentation set. The source-built SBF artifact is
`target/deploy/equinox.so`, SHA-256
`f821f560499508efa26d85f025910681466f524a4665b54abd6229d96cdeba60`, size
`151,608` bytes. `cargo fmt --check`, `cargo check -p equinox`, debug and
release Rust tests, SBF compilation, root TypeScript checks/tests, and Worker
typecheck/tests passed. No deployment or live transaction was attempted.

The runtime remains externally unverified because the installed SBPF runtime
does not accept the compiler's ELF/SBPF generation. Live Pyth, Privy and
MagicBlock verification also remain externally blocked by credentials and/or
network/service availability.

## Corrected Implementation Evidence (2026-09-16)

The preceding “Full Code-Completion Pass” heading is historical wording, not a
claim that every production path is complete. The current implementation has
concrete account settlement, registry configuration, SPL transfer invocation,
Pyth verifier-CPI construction, D1 repositories, Durable Object streaming,
and HTTP/RPC client transports. It does **not** yet provide a verified SBF
runtime execution, a live Pyth signed update, onchain MagicBlock lifecycle
CPI, complete session replay consumption, or a complete external indexer and
keeper fleet. Those items remain partial or unverified.

| Check | Result |
| --- | --- |
| Source commit for current SBF | `8340d1c` |
| Rust debug/release tests | `53 passed; 0 failed` / `53 passed; 0 failed` |
| Root TypeScript tests | `38 passed; 0 failed` |
| Worker runtime tests | `13 passed; 0 failed` |
| Clean `npm ci`, lint, typecheck, test, build | passed |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `3b5a4b5272e8a14f25391d4e635a1867e9a37478e9747cd7e291c8822cc645a4` |
| SBF size | `174,384` bytes |
| SBF stack diagnostic | no stack-frame diagnostic emitted |

This is SBF compilation evidence only. It does not establish runtime, CPI,
ER, devnet, Privy, or authenticated Pyth verification.

## Priority 4: Custody, Vault Accounting, Fees, Insurance, Reconciliation (2026-09-16)

Completes production custody on top of the existing (not a parallel) model
from Priorities 1-3: complete collateral-accounting documentation and a
`withdrawal_buffer` term in `risk::prepare_withdrawal`; full vault
configuration/validation (Model A: canonical PDA vault + vault-authority
PDA); hardened `InitializeVault`/`DepositCollateral`/`WithdrawCollateral`;
new `TransferToInsuranceFund`, `WithdrawProtocolFees`,
`WithdrawInsuranceFunds`, `RecordBadDebt`, `ResolveBadDebt`, `ReconcileVault`
instructions (opcodes 34-39); automatic protocol-fee crediting from real
fills and liquidations; a permissionless vault-reconciliation state machine
(`Reconciled`/`SurplusDetected`/`DeficitDetected`/`RecoveryRequired`) that
auto-pauses the market on a detected deficit and blocks withdrawals until
resolved; `pinocchio_log`-based custody events; and matching TypeScript
client builders/decoders. Full detail in `docs/custody.md`,
`docs/risk.md`, and `docs/program-layout.md`.

Two real, previously-undetected integration defects were found and fixed
(both documented in `docs/custody.md`):

1. `validate_custody_tokens` independently gated custody movement on
   `reserved_upgrade[2] != 0` -- the same byte `DelegationStatus`
   (introduced in Priority 1) uses -- which would incorrectly reject a
   `Restored` market's withdrawal even though
   `header.l1_withdrawals_allowed()` (checked separately) already permits
   it. Fixed to use `l1_withdrawals_allowed()` as the single source of
   truth.
2. `deposit_collateral`/`withdraw_collateral` each held a `Ref<Account>`
   (from decoding the source/destination SPL token account) alive across
   the SPL `Transfer` CPI that also touches the same account.
   `pinocchio_token`'s own CPI account writer rejects any account it
   touches that is still borrowed, and this check runs unconditionally
   (not only on-chain) -- meaning **every deposit and withdrawal would
   have failed on a real cluster**, not only in tests. Undetected until
   now because no prior test exercised either handler's CPI path
   end-to-end. Fixed by scoping each decode-and-validate block so the
   `Ref` drops before the CPI executes.

| Item | Recorded value |
| --- | --- |
| Source commit | current working tree (pre-commit; see below) |
| `cargo fmt --check` | passed |
| `cargo check -p equinox` | passed |
| Rust debug tests | `128 passed; 0 failed` |
| Rust release tests | `128 passed; 0 failed` |
| Root TypeScript tests | `42 passed; 0 failed` |
| Worker runtime tests | `14 passed; 0 failed` |
| `npm run lint` | passed |
| `npx tsc --noEmit` | passed |
| `npm run build` | passed |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `156bd1f1f825ee95db08d3ae8664b316450fc84a4d35df1d7d8ca17f11d30921` |
| SBF size | `229,792` bytes |
| SBF stack diagnostic | no stack-frame diagnostic emitted |
| `MARKET_ACCOUNT_SIZE` | unchanged (`222,752` bytes) -- new fields fit within `reserved_upgrade` |

New Rust tests: `programs/equinox/tests/custody.rs` (10 tests: vault
init/duplicate/wrong-authority, deposit credit/non-owner/insufficient-
balance/aliasing, withdrawal success/margin-violation/delegation-regression/
reconciliation-gate, fee/insurance ledger transfer and authority rejection,
bad-debt record/resolve, full reconciliation state-machine escalation) plus
one new test in `tests/account_settlement.rs`
(`crossing_fill_credits_the_protocol_fee_ledger`, verifying real fee
crediting from an actual crossing fill, not just the ledger handlers in
isolation). New TypeScript tests in `clients/equinox/src/index.test.ts`
cover every new instruction's discriminator/account order and the
`decodeCustodyEvent` log-line parser.

This is SBF compilation and unit/wire-conformance evidence only. Live SPL
Transfer CPI execution, live reconciliation against a real vault balance,
and live fee/insurance withdrawal remain runtime-unverified (the same
`invoke_with_program`/`invoke_signed_with_program` no-op-off-SBF limitation
documented for Priorities 1-3 in `docs/magicblock.md` and `docs/oracle.md`).
**Audit pending. Production not approved.**

## Layout Formalization: MARKET_VERSION 2 (2026-09-17)

The Priority-4 custody ledger fields became permanent (not scratch)
protocol fields: `MARKET_VERSION` bumped `1 -> 2`; `validate()` rejects any
stored version that doesn't match exactly, so a version-1 account is never
silently reinterpreted. `clients/equinox/src/index.ts::decodeMarketState`
decodes the five new fields and enforces the same version check, cross-
checked against `state.rs`'s byte offsets by a new Rust golden-vector test.
Also added: two tests proving withdrawal health uses funding-settled and
fee-settled equity, not a naive pre-settlement figure.

| Item | Recorded value |
| --- | --- |
| Rust tests (debug/release) | `132 passed; 0 failed` each (+4) |
| Root TypeScript tests | `43 passed; 0 failed` (+1) |
| SBF artifact | `target/deploy/equinox.so` |
| SBF SHA-256 | `444bb2c8ae76b178ab7432e1f7d730d51a6910502d11e8fefe8574ab96b6774e` |
| SBF size | `229,792` bytes (unchanged -- a version constant, not a layout size change) |

A real, previously-passing test (`lib/rpc-transport.test.ts`) had a
hardcoded version-1 fixture that had to be updated to version 2 -- concrete
proof the version check is live and enforced end to end, not merely
declared.

## Priority 5/6: Durable L1/ER Indexer, Private Projections, Dead-Letter Keepers (2026-09-17)

No Rust source changed in this pass, so the SBF artifact above still
applies unchanged.

Real WebSocket subscription transports for Solana L1 and the MagicBlock ER
(`workers/src/ws-transport.ts`), the custody event decoder wired end to end
into the durable D1 ingestion pipeline with a concrete gap-recovery account
fetcher (`workers/src/ingestion-pipeline.ts`), a scheduled-worker ingestion
tick (`workers/src/index.ts::runIngestionTick`), a foundational ER/L1
execution-status reconciliation model (`workers/src/execution-status.ts`),
access-controlled private trader projections over the existing
`MarketStream` Durable Object (`workers/src/private-sessions.ts`, migration
`0005_private_sessions.sql`), and a real dead-letter queue plus keeper
health endpoint (`workers/src/repositories.ts::DeadLetterRepository`,
`workers/src/keepers.ts::runDurableKeeperWithDeadLetter`,
`GET /v1/health/keepers`). Full detail in `docs/worker.md`,
`docs/indexer.md`, `docs/magicblock.md`, and `docs/security.md`.

| Item | Recorded value |
| --- | --- |
| Worker (Vitest, real Miniflare/D1/DO) tests | `66 passed; 0 failed` (was 21 before this pass) |
| Root TypeScript tests | `43 passed; 0 failed` (unchanged from the layout-formalization entry) |
| Rust tests | unchanged (`132 passed` debug/release) -- no Rust source touched |
| `npm run lint` (root) | passed |
| `npx tsc --noEmit` (root and `workers/`) | passed |
| `npm run build` (root) | passed |
| SBF artifact | unchanged from the layout-formalization entry: `444bb2c8ae76b178ab7432e1f7d730d51a6910502d11e8fefe8574ab96b6774e`, `229,792` bytes |

Honestly still open (see `docs/worker.md`'s per-section notes for detail):
the WebSocket transport is not wired into the scheduled ingestion loop
(HTTP polling is the currently-wired path); only custody events are
decoded).

**Update (this session):** the program now emits a complete 61-kind
versioned binary event ABI (`docs/events.md`), 50 of which are wired into
real production handlers; ER/L1 reconciliation is now wired to real
on-chain reads (`docs/magicblock.md`); all six keeper jobs exist with
real lease/idempotency/transport/confirmation wiring and a real
production-capable signer (`docs/transports.md`) -- the one remaining
gap there is real Solana wire-format transaction construction inside a
keeper job, an interfaced-out dependency boundary (`workers/` has zero
runtime dependencies), not missing logic. Rebuilt the SBF artifact in a
clean disposable worktree with the correct `--features bpf-entrypoint`
flag (omitting it silently produces a ~1.3KB stub with no entrypoint):
253,424 bytes,
SHA-256 `63a4274f2ac1c95afa53299b986c8eb02cc206d64af7706a4e411c3caa8b1ec6`,
byte-identical across the clean worktree and the working tree. 155 Rust
tests, 155 Worker tests, 46 root TypeScript tests. **Audit pending.
Production not approved.**
