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

NOT PASSED. The current artifact is a successful SBF build, but the complete
late-failure rollback proof and exhaustive account-level settlement matrix are
not complete. Phase 2 local-validator work and all external integrations are
therefore blocked.

The latest candidate artifact is `081868a97f4da71a7cea5a226076a03f6fe103db3d6beac98748f094624f9564`
(`117,944` bytes). It passes the current Rust debug/release suites (`31`
tests each) and the SBF stack verifier. The immutable planner is currently a
preflight and deterministic arena apply; complete precomputed risk settlement
and rollback work remains.

The detailed toolchain, artifact, and test evidence is recorded in
`docs/stockstream-build-record.md`.
