# Backpack Stock-Market Reference

Research date: 2026-09-15. Source: [Backpack Exchange documentation](https://docs.backpack.exchange/).

## Facts Observed

- Securities expose market sessions and session-specific quantity constraints through `/api/v1/securities`.
- Market sessions and full-day or shortened holidays are first-class endpoints.
- RFQ symbols such as `AAPL.US_USDC_RFQ` are distinct from spot order-book symbols such as `MU.US_USDC`.
- During open security sessions, stock trading uses RFQ; listed securities can use a spot book outside market hours.
- Deferred-settlement RFQ acceptance is binding, locks required funds, and releases them if the settlement window expires.
- Orders enter a single linear command stream. The documented engine sequence is clear, match, settle.
- Execution responses and WebSocket updates are separate channels. Public and private streams expose different state.
- The documentation describes a 100 ms taker speed bump, with post-only orders and cancellations exempt.
- Balance, order, position, depth, mark-price, stock-price, open-interest, and trade streams provide absolute or sequenced state that clients can reconcile.

## Useful Product Behavior

StockStream should make session state, shortened sessions, holidays, available
collateral, reserved collateral, and authoritative sequence numbers explicit.
Its atomic instruction can follow the same clear -> match -> settle ordering.
Client acknowledgements should remain distinct from ER acceptance and L1
commitment. Snapshot plus delta streams should use absolute reconcilable state
for balances, orders, and positions.

## What StockStream Must Not Copy

Backpack is not StockStream's oracle, onchain specification, account-layout
guide, liquidation-price authority, Pyth substitute, or MagicBlock substitute.
Its proprietary implementation must not be copied. StockStream is a USDC-
settled perpetual CLOB, not an RFQ venue, and tokenized-stock spot behavior
must not replace the AAPL-PERP risk path.

## Differences

Backpack separates RFQ and spot-stock execution and may defer broker settlement.
StockStream performs bounded matching and settlement atomically inside a Solana
instruction. Backpack's command stream is an offchain engine concern; StockStream
must prove account ownership, PDA derivation, byte layouts, and rollback. ER
acceptance is also distinct from StockStream's later L1 commitment.

## Concrete Implications

- Pyth remains the sole production risk-price source.
- `MarketSession` and `TradingStatus` remain protocol-level controls.
- Holiday and shortened-session configuration belongs in market configuration.
- Available, reserved, and later locked collateral need separate ledgers.
- Strict WebSocket sequences and snapshot resynchronization are required.
- A taker speed bump is optional product research, not a Gate 1 requirement.
- Deferred-settlement RFQ support may be considered later for tokenized-stock
  spot trading, but it must not replace the perpetual CLOB.
