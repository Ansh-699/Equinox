# StockStream Program Build Record

Date: 2026-09-15
Scope: standalone program-foundation milestone only

| Item | Recorded value |
| --- | --- |
| Rust | `rustc 1.98.0 (88d9e12ae 2026-08-18)` |
| Solana / Agave CLI | `solana-cli 4.2.1 (src:75f9b5b4; feat:21b0d33a, client:Agave)` |
| Pinocchio | `0.11.2` exactly |
| StockStream program ID | `6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU` |
| SBF artifact | `target/deploy/stockstream.so` |
| SBF SHA-256 | `c298700f1dc22690e9988bc59e8b8c8bc76dc70c6e321105cc19400deb052e79` |

## Phase 1 Verification Results

```text
$ cargo fmt --check
exit 0

$ cargo check -p stockstream
Finished `dev` profile [unoptimized + debuginfo]

$ cargo test -p stockstream
7 integration tests passed; 0 failed

$ NO_DNA=1 cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint
Finished `release` profile [optimized]
```

The artifact was built from the standalone `stockstream` crate. The deployment
output directory contains only `stockstream.so`; no generated default keypair is
retained there. The program keypair used for the recorded program ID is kept
outside version control in `.keys/stockstream-program-keypair.json`.

## Phase 2 Verification Results

Scope: market-state layouts, two fixed-capacity PATRICIA arenas, oracle-pegged
order evaluation, deterministic bounded matching, and native tests only.

| Item | Recorded value |
| --- | --- |
| Pinocchio | `0.11.2` exactly |
| SBF artifact | `target/deploy/stockstream.so` |
| SBF SHA-256 | `2f05285270666a4431fab314e5f9061d8d0170583681214637c7059ff8eb3623` |
| SBF size | `35,824` bytes |
| Native tests | `20 passed; 0 failed` |
| Release tests | `20 passed; 0 failed` |
| Compute-unit measurement | Not available: no local-validator instruction benchmark was run in this scope. |

```text
$ cargo fmt --check
exit 0

$ cargo check -p stockstream
Finished `dev` profile [unoptimized + debuginfo]

$ cargo test -p stockstream
13 order-book tests + 7 program-boundary tests passed; 0 failed

$ cargo test -p stockstream --release
13 order-book tests + 7 program-boundary tests passed; 0 failed

$ NO_DNA=1 cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint
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
| SBF artifact | `target/deploy/stockstream.so` |
| SBF SHA-256 | `228aa1c9f1d1ac45494f9a118e3efced1695cc05b169c9f14b6cadcd743c5314` |
| SBF size | `49,232` bytes |
| Compute-unit measurement | Not available; no validator benchmark was run. |

```text
$ cargo fmt --check
exit 0
$ cargo check -p stockstream
exit 0
$ cargo test -p stockstream
27 passed; 0 failed
$ cargo test -p stockstream --release
27 passed; 0 failed
$ cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint
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
| SBF artifact | `target/deploy/stockstream.so` |
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
| `cargo check -p stockstream` | passed |
| `cargo build-sbf --features bpf-entrypoint` | passed; no stack diagnostic |
| SBF SHA-256 | `081868a97f4da71a7cea5a226076a03f6fe103db3d6beac98748f094624f9564` |
| SBF size | `117,944` bytes |

This is Gate 1 progress, not a pass. The handler now applies the planned arena
actions and remainder, but complete precomputed maker/taker risk, margin,
funding, event, rollback, and randomized account-model coverage remain.

## Scratch-Backed Settlement Candidate (2026-09-15)

Gate 1 remains **NOT PASSED**. The candidate moves the production plan region
from the handler frame into a per-market/per-seat StockStream-owned settlement
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
| SBF artifact | `target/deploy/stockstream.so` |
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
| `cargo check -p stockstream` | passed |
| `cargo build-sbf --features bpf-entrypoint` | passed; no stack-frame diagnostic |
| SBF artifact | `target/deploy/stockstream.so` |
| SBF SHA-256 | `7bfad1e46257677bdc7ee7ec8fe0dfbab581df6eda2b968328a8c639f12e5377` |
| SBF size | `121,952` bytes |
| MVP Gate 1 | `PASS` |
| Production hardening / audit / approval | `PENDING / PENDING / NO` |

The older pre-correction artifacts and candidate hashes in this record are
historical only and are superseded by the artifact above. They must not be
deployed as StockStream evidence.

## Post-Gate-1 Verified Build (Current Source)

The current source rebuild completed after the custody/oracle/lifecycle
boundary work. This artifact is separate from the preserved Gate 1 artifact.

| Check | Result |
| --- | --- |
| Source commit | `2794eca` plus repository cleanup changes |
| `cargo fmt --check` | passed |
| `cargo check -p stockstream` | passed |
| Rust debug tests | `45 passed; 0 failed` |
| Rust release tests | `45 passed; 0 failed` |
| SBF build | passed |
| SBF artifact | `target/deploy/stockstream.so` |
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
`target/deploy/stockstream.so`, SHA-256
`f821f560499508efa26d85f025910681466f524a4665b54abd6229d96cdeba60`, size
`151,608` bytes. `cargo fmt --check`, `cargo check -p stockstream`, debug and
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
| Source commit for current SBF | `f709eea` |
| Rust debug/release tests | `53 passed; 0 failed` / `53 passed; 0 failed` |
| Root TypeScript tests | `38 passed; 0 failed` |
| Worker runtime tests | `13 passed; 0 failed` |
| Clean `npm ci`, lint, typecheck, test, build | passed |
| SBF artifact | `target/deploy/stockstream.so` |
| SBF SHA-256 | `dc27921ff62fa2e3f045f83125e117763a0ed8c116d4d5513b0f6137e7fd2851` |
| SBF size | `173,872` bytes |
| SBF stack diagnostic | no stack-frame diagnostic emitted |

This is SBF compilation evidence only. It does not establish runtime, CPI,
ER, devnet, Privy, or authenticated Pyth verification.
