# Keepers

Keepers use leases, idempotency keys, bounded exponential retry and redacted
structured logs. Pyth updates are monotonic and duplicate-suppressed. Commit
keepers target the configured 30-second interval, while cleanup keepers advance
bounded expiry/invalid-order work without unbounded scans.
