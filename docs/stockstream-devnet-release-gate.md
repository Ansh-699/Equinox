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

## Deferred Production Hardening

The hackathon MVP gate intentionally defers the exhaustive settlement
permutation matrix, large randomized economic model, fuzzing, complete
liquidation/event-ring matrices, long-duration ER failure simulation, and an
independent audit. These remain required for production approval. The current
artifact must not be described as production-ready or audited.
