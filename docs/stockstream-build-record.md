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
