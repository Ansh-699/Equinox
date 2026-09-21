# Post-entitlement lifecycle checklist

This checklist is prepared only. It must not be executed while core activation
returns `OracleUnavailable (0x6004)` or while the Pyth smoke probe has fewer
than two entitled streams.

1. Rerun the server-only Pyth probe for `Equity.US.AAPL/USD` (ID `922`) on
   `fixed_rate@50ms`; retain redacted stream and timestamp evidence.
2. Submit the signed Pyth update through the existing server-side path and
   activate the fresh V3 core `7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei`.
3. Create and verify a fresh trader seat against the fresh core and all four
   seat/event shard sets.
4. Delegate the complete 27-account bundle to one MagicBlock validator; verify
   every writable account has ER ownership before any order.
5. Authorize a Privy session for the expected linked wallet; verify the relayer
   service token, relayer signer, nonce, and program allowlist.
6. Submit one real session-signed order, then an opposing order; verify the
   fill event, balances, position, and event sequence on ER and L1.
7. Read back the core, all shards, trader seat, positions, and events.
8. Commit the bounded shard bundle and verify commit epoch/finality.
9. Request undelegation only after commit finality; verify the MagicBlock
   restoration callback and L1 ownership for every account.
10. Reconcile custody and execute a withdrawal only after restored ownership,
    reconciliation, and margin/ledger checks pass.

Explicit prohibitions: no Pyth bypass, no fabricated message, no guessed
MagicBlock wire format, no preserved-core mutation, and no order/fill/commit
transaction before the complete delegated bundle is valid.
