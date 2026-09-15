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
| SBF SHA-256 | `c8fc0768c6c333ed29609f958100ee231909009e8b699ac4347357b4fe844eb7` |
| SBF size | `114,864` bytes |

This is Gate 1 progress, not a pass. The handler still applies through the
legacy mutating matcher after preflight; complete two-phase maker/taker risk
settlement, rollback, and the requested randomized account model remain.
