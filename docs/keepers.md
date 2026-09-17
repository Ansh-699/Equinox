# Keepers

Keepers use leases, idempotency keys, bounded exponential retry and redacted
structured logs. Pyth updates are monotonic and duplicate-suppressed. Commit
keepers target the configured 30-second interval, while cleanup keepers advance
bounded expiry/invalid-order work without unbounded scans.

**Update:** all six keeper jobs are now concretely implemented in
`workers/src/keeper-jobs.ts` (Pyth oracle, MagicBlock commit, funding,
market session/holiday, expiry/invalid-order cleanup, liquidation), each
built on the durable lease/fencing/idempotency/dead-letter harness above
plus the new production signer (`docs/transports.md#signer-infrastructure`)
and transaction transports (`docs/transports.md#transaction-transports`).
The liquidation keeper always re-reads authoritative seat state before
submitting -- it never liquidates from a Worker-side projection alone. The
one deliberately interfaced-out piece is real Solana wire-format
transaction construction/signing (`TransactionBuilder`); see
`docs/transports.md` for why. 19 tests in `keeper-jobs.test.ts`.
