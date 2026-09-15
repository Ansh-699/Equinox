# StockStream Devnet Release Gate

Status: NOT READY FOR DEVNET DEPLOYMENT

This gate records only the standalone program-foundation milestone. No devnet
deployment or external protocol integration was performed in this milestone.

## Passed Foundation Gates

| Gate | Evidence | Status |
| --- | --- | --- |
| Independent workspace | Root Cargo workspace contains only `programs/stockstream`. | PASS |
| Program identity | `6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU` is used by the Rust program and client constants. | PASS |
| Pinocchio version | Cargo resolves `pinocchio v0.11.2`. | PASS |
| Native verification | Formatting, check, 20 debug tests, and 20 release tests completed successfully. | PASS |
| Market-state layout | Versioned `MarketState`, two independent 90,640-byte side arenas, and 88-byte tagged node ABI assertions compile. | PASS |
| PATRICIA arena | Shared per-side allocator, two roots, branch compression, expiry caches, free-list reuse, and integrity validation are tested. | PASS |
| Deterministic matching | Bounded fixed/pegged matching, cross-tree FIFO, post-only, IOC, partial fills, self-cancel, invalid cleanup, and unavailable-price suspension tests pass. | PASS |
| SBF verification | `cargo build-sbf --manifest-path programs/stockstream/Cargo.toml --features bpf-entrypoint` completed successfully. | PASS |
| Artifact evidence | `target/deploy/stockstream.so`; SHA-256 `2f05285270666a4431fab314e5f9061d8d0170583681214637c7059ff8eb3623`; 35,824 bytes. | PASS |

## Current Program Boundary

The program implements strict instruction decoding, program-ID consistency
checks, the `InitializeMarket` account-validation boundary, and Phase 2's
fixed-capacity market-state/order-book foundation. It does not yet persist a
market account through an instruction, move assets, invoke another program, or
perform an external integration.

## Devnet Blockers

- Persistent market account creation and instruction wiring for the Phase 2 layout.
- Authority model and market configuration lifecycle.
- Asset custody and token-program validation.
- Program-test coverage using a local validator.
- Security review of the expanded instruction surface.
- Explicit deployment transaction and post-deploy binary/program-ID verification.

The detailed toolchain, artifact, and test evidence is recorded in
`docs/stockstream-build-record.md`.
