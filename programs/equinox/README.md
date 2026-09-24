# Equinox on-chain program

This Pinocchio program implements the exchange's markets, order matching, risk checks, custody, sessions, and MagicBlock lifecycle. The current devnet program ID and market addresses are in [`config/equinox-deployment.json`](../../config/equinox-deployment.json). The [root README](../../README.md) shows where the program sits in the full system.

## V3 market state

One market consists of a core and 26 child accounts:

| Account | Count | Purpose |
| --- | ---: | --- |
| Core | 1 | Market configuration, risk state, oracle binding, and snapshot progress |
| Book pages | 18 | Paged bid and ask order storage |
| Seat shards | 4 | Trader balances and positions |
| Event shards | 4 | Execution events |

The 27-account execution bundle is delegated to the MagicBlock rollup. The collateral mint's token vault and authenticated oracle snapshot stay on Solana L1. A rollup seat represents a claim against collateral held in that vault; it is not the vault itself.

```mermaid
sequenceDiagram
  participant W as Trader wallet
  participant L1 as Solana L1
  participant ER as MagicBlock rollup
  participant K as Keeper

  W->>L1: Deposit USDC to vault; create inbox receipt
  W->>ER: Claim inbox credit to seat
  W->>ER: Place or cancel signed order
  ER->>ER: Match and update seat/book/event shards
  K->>ER: Commit shards and core
  ER-->>L1: Publish committed market state
  W->>ER: Request withdrawal after risk check
  W->>L1: Claim receipt to wallet token account
```

Orders need a fresh authenticated price and an open trading session. TSLA uses a Pyth-verified L1 snapshot; reporter-priced markets use an authority-bound, rate-limited snapshot. Withdrawals have a separate stale-price rule described in [`docs/architecture.md`](../../docs/architecture.md). See [`docs/program-layout.md`](../../docs/program-layout.md) for account offsets and [`docs/custody.md`](../../docs/custody.md) for the full money flow.

## Source map

| File | Responsibility |
| --- | --- |
| `src/v3.rs`, `src/book.rs`, `src/state.rs` | V3 state, book, and account structures |
| `src/instruction.rs`, `src/handlers.rs` | Instruction dispatch and core handlers |
| `src/inbox.rs` | Deposit and withdrawal receipts |
| `src/oracle_snapshot.rs`, `src/handlers_oracle.rs` | Price authentication and snapshot updates |
| `src/risk.rs`, `src/session.rs` | Margin rules and bounded session authority |
| `src/magicblock.rs`, `src/magicblock_schedule.rs` | Delegation, commits, and rollup scheduling |
| `tests/` | Host and runtime behavior checks |

The matching TypeScript builders and decoders live in [`clients/equinox/`](../../clients/equinox/README.md). Change an instruction or account layout in both places and regenerate the ABI manifest before shipping a client.

## Build and inspect

From the repository root:

```bash
cargo test -p equinox
cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint
npm run check:equinox-abi
```

The SBF build needs the pinned Solana/Agave toolchain; [`toolchain/equinox-runtime.env`](../../toolchain/equinox-runtime.env) and [`scripts/install-equinox-toolchain.sh`](../../scripts/install-equinox-toolchain.sh) define it. The [runtime workflow](../../.github/workflows/equinox-runtime.yml) checks the compiled artifact and runs tests against it.

For deployed behavior, trust the [current status and evidence](../../docs/status/current.md) over an older design document. In particular, the current devnet delegation program does not complete V3 market undelegation, and there is no finished L1 emergency exit for a permanently unavailable rollup.
