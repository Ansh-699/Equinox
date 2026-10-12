# Risk

Risk uses checked integer arithmetic. Each market has initial and maintenance
margin, leverage, position and open-interest limits. Available collateral is
distinct from reserved order margin. Funding and fees are separate ledger
changes. Liquidation is rejected for healthy accounts and uses the configured
maintenance threshold, with bankruptcy routed to insurance accounting.

## Immediate-settlement PnL model

`risk::apply_fill` and `risk::settle_funding` deduct trading fees and funding
straight into `TraderSeat::realized_pnl` at the moment they're incurred; this
program does not maintain separate deferred "pending fee" or "accrued
funding" fields. `equity = available_collateral + realized_pnl +
unrealized_pnl` (`risk::equity`) is the complete health/margin picture, but
`available_collateral` is the trader's token claim against the vault.
See `docs/custody.md` for the withdrawal-health formula and how protocol
fees, insurance, and reconciliation use this model.

`risk::prepare_withdrawal` takes an explicit `withdrawal_buffer: i128`
parameter (`risk::DEFAULT_WITHDRAWAL_BUFFER = 0`), added on top of the
maintenance-margin and reserved-order-margin requirement:
`post_withdraw_equity >= maintenance_margin(|position|) + reserved_margin +
withdrawal_buffer`. No governance instruction currently sets a
non-zero per-market buffer; introducing one later means passing a
header-stored value into this same call, not changing the formula.

**Update:** `liquidate` now emits `LiquidationStarted`, `PositionChanged`,
`MarginChanged`, and `PositionLiquidated` (plus a conditional
`ProtocolFeesChanged`) for every liquidation, and `place_order_core`
emits `FundingSettled` for the taker seat's own funding settlement (see
`docs/events.md`). Bad-debt accounting uses the `record_bad_debt` and
`resolve_bad_debt` governance instructions.
