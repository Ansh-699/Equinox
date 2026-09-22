# StockStream Architecture

StockStream is a generic multi-market perpetual CLOB. An exchange registry owns
instrument definitions; each `PerpMarket` owns its own arenas, seats, event ring,
vault configuration, oracle policy, risk parameters and delegation state.

L1 owns configuration, custody and authorities. MagicBlock ER owns delegated
hot state. ER acceptance and an L1 commit are separate states in every client
and indexer projection. Runtime execution and live external verification remain
unverified in the current environment.

## Canonical execution architecture

```text
Pyth Lazer signed update
        |
        v
Solana L1: Pyth authenticity and fee verification
        |
        v
L1-owned OracleSnapshotV3 (read-only to ER)
        |  measured, bounded read-through
        v
MagicBlock Ephemeral Rollup
  -> validated oracle observation
  -> 27-account V3 execution bundle
  -> PATRICIA traversal and matching
  -> seats, positions, fees, funding, and events
        |
        v
Coherent ER commit to Solana L1
        |
        v
Separately verified restoration, then withdrawal
```

L1 owns market configuration, token custody, Pyth verification, authorities,
and the oracle snapshot. ER owns only delegated execution state. Pyth treasury,
storage, payer, fee, and token-vault accounts are never delegated. The Worker
may index, expose diagnostics, and relay authenticated requests; it is not a
price source and never performs matching.

### Required lifecycle gates

1. Configure a non-zero, valid SPL collateral mint before activating a market.
   Activation must fail before mutation for a zero, malformed, or substituted
   mint. The existing `82yWLi...` core has a zero mint and is an abandoned test
   artifact; it must not be repaired or delegated. Create a fresh market under
   the existing program after local verification.
2. Verify the signed Pyth update on L1 and materialize one authenticated
   `OracleObservationV3` into `OracleSnapshotV3`. The observation must include
   feed, channel, exponent, price, confidence, publish time, sequence, session,
   and trading status. Reject stale, future, replayed, wrong-feed, wrong-channel,
   wrong-exponent, halted, restricted, or closed observations.
3. Every session, order, matching, funding, liquidation, deposit-risk, and
   withdrawal-risk decision must consume that same snapshot observation. A
   timestamp-only check or a stale cached core price is insufficient.
4. Pre-create the session PDA on L1 and prove its ER write lifecycle with a
   separate session signer. Precreation does not prove that ER can mutate it.
5. Delegate the complete canonical 27-account execution bundle only after the
   fresh oracle, seat, and L1 collateral deposit are proven. Snapshot and
   custody accounts remain outside the bundle.
6. Prove L1-to-ER snapshot propagation with the pinned MagicBlock integration,
   including latency below the ten-second freshness limit. MagicBlock's feed
   1435 account is currently visible in ER, but its 144-byte schema is not a
   drop-in replacement for StockStream's authenticated snapshot because it
   lacks channel/session/status/sequence fields. A reviewed adapter or bridge
   must preserve those fields before orders are allowed.
7. Prove a real ER resting order, opposite order, fill, accounting readback,
   and coherent commit. Restoration and withdrawal are independent gates.

### Current release blockers

The fresh `8Ucdsd3...` program is executable and the 128-byte snapshot account
exists, but the current fresh core has no collateral mint, the snapshot is not
authenticated/populated, ER snapshot refresh is unproven for TSLA feed 1435,
and session-account writability in ER is unproven. Therefore delegation,
orders, fills, commits, restoration, and withdrawals must remain blocked.

The frontend and Worker must consume one deployment manifest containing the
program, artifact hash, exchange, instrument, core, snapshot, collateral mint,
cluster, ER validator, and Pyth metadata. This prevents combinations such as
the new program paired with the legacy AAPL core.
