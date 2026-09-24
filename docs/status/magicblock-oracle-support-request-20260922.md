# MagicBlock oracle compatibility request — TSLA feed 1435

This is a read-only support package. It authorizes no transaction.

## Observed Devnet state

- Oracle program: `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`
- Update signer: `MPUxHCpNUy3K1CSVhebAmTbcTCKVxfk9YMDcUP2ZnEA`
- Feed PDA: `8L7ccCxTBZaLsMMdhAod5fFnpdEWGSDPW4y1td7y3y8N`
  (`["price_feed", "pyth-lazer", "1435"]`)
- Feed: `Equity.US.TSLA/USD`, numeric ID `1435`
- Catalog channel: `fixed_rate@50ms`, channel ID `2`
- Catalog exponent: `-5`
- Account: Anchor `PriceUpdateV3`, 144 bytes
- ER owner: oracle program; L1 owner: delegation program
- ER stored exponent: `5`; stale L1 delegation-time copy: `8`

Raw bytes, decoded update instruction and cross-feed table:
`docs/status/magicblock-oracle-exponent-resolution-20260922.json`.

## Exponent: resolved as a sign convention

The stored exponent is MagicBlock's decimal-place count, i.e. the negated
Pyth exponent:

- Upstream `sample` (commit `c6d08ac`) scales by `10^-exponent` and logs
  `* 10^-{exponent}`; upstream tests divide by `10 ** exponent`.
- Every live ER feed follows `stored = -catalog`: BTC/ETH/SOL store `8`
  (catalog `-8`), AAPL/NVDA/TSLA store `5` (catalog `-5`).
- The pusher writes Lazer's quantized price unscaled. TSLA raw
  `37867751 × 10^-5 = $378.68`; under the Pyth sign it would be
  `$3.8 × 10^12`.
- The live `UpdatePriceFeed` wire (215 bytes, matches upstream `UpdateData`)
  carries no exponent field.

Equinox now accepts exactly `stored == -catalogExponent` in its
diagnostics decoder and returns the canonical `-5`. It never accepts both signs.
The upstream README's `10_f64.powi(price.exponent)` example contradicts the
program and should be corrected.

The L1 `8` is a separate problem. The stale L1 copies for NVDA (1314) and TSLA
(1435) were initialized with `8`, matching the historical `InitializePriceFeed`
at slot `426478311` (`2RemknQv…`). The ER copies hold `5`, but upstream updates
preserve the exponent, and no public instruction explains the change.

## Remaining incompatibilities

The account cannot back Equinox's authenticated `OracleSnapshotV3`:

1. **Confidence:** never written. Initialized to `0`, preserved by updates,
   and the pusher subscribes only to `price`.
2. **Provenance:** the Pyth Lazer signature (`r`, `s`, signer key) is passed
   in instruction data but never verified onchain. `verification_level = Full`
   is hard-coded. Trust reduces to the `MPUx…` key.
3. **Initialization is permissionless:** anyone may create a feed PDA first
   and choose its exponent. Consumers must check `write_authority == MPUx…`.
4. **Missing fields:** no market session, trading status, channel, or
   monotonic sequence. `posted_slot` is an ER slot.
5. **Feed ID bytes** hold the PDA address, not the Lazer ID. The Lazer ID is
   bound only by the PDA seed text.

## Questions for MagicBlock

1. Is `stored = -pythExponent` the committed, versioned convention for every
   `pyth-lazer` feed, including future re-initializations?
2. How did the ER copies of 1314 and 1435 change from `8` to `5`, and will the
   L1 copies ever be committed or reinitialized?
3. Can the pusher subscribe to `bestBidPrice`/`bestAskPrice` or `confidence`,
   `marketSession`, and `feedUpdateTimestamp`, and store them?
4. Is there, or will there be, a variant that verifies the Lazer Ed25519
   signature onchain, or that exposes the signed payload so a consumer can
   verify it?
5. Which channel does the devnet pusher use for feed 1435?
6. What is the supported way for an undelegated L1 account (Equinox's
   `OracleSnapshotV3`) to be kept current in ER, and what is its latency
   bound?

Until 3, 4 and 6 are answered, Equinox rejects the account and does not
delegate, authorize sessions, place orders, match fills, commit, restore, or
withdraw.
