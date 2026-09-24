/**
 * Port of the exact liquidation-health formula in
 * `programs/equinox/src/risk.rs` (`equity`, `unrealized_pnl`,
 * `notional`, `fee`/`maintenance_margin`, `is_liquidatable`) -- used only to
 * decide which candidates are worth *building a liquidation transaction
 * for*. The on-chain program re-derives and re-checks the same condition
 * itself inside `liquidate` before it lets anything settle, so a wrong
 * answer here can only waste a transaction, never cause an unsafe
 * liquidation. Kept in exact arithmetic parity (integer division, same
 * truncation direction) with the Rust source rather than reimplemented
 * loosely, specifically so that parity is easy to audit field-by-field.
 */

const BPS_DENOMINATOR = 10_000n;

export interface SeatRiskInputs {
  availableCollateral: bigint;
  reservedMargin: bigint;
  basePosition: bigint;
  quoteEntryValue: bigint;
  realizedPnl: bigint;
}

/** `risk::notional`: requires a positive price and non-negative quantity. */
export function notional(quantity: bigint, price: bigint): bigint {
  if (price <= 0n || quantity < 0n) throw new RangeError("invalid price/quantity for notional");
  return quantity * price;
}

/** `risk::fee`/`risk::maintenance_margin`: `notional * bps / 10000`, truncating toward zero like Rust's `checked_div`. */
export function feeBps(notionalValue: bigint, bps: number): bigint {
  return (notionalValue * BigInt(bps)) / BPS_DENOMINATOR;
}

/** `risk::unrealized_pnl`. */
export function unrealizedPnl(seat: SeatRiskInputs, markPrice: bigint): bigint {
  if (markPrice <= 0n) throw new RangeError("invalid mark price");
  const current = seat.basePosition * markPrice;
  const entry = seat.basePosition === 0n ? 0n : seat.quoteEntryValue;
  return current - entry;
}

/** `risk::equity`. */
export function equity(seat: SeatRiskInputs, markPrice: bigint): bigint {
  return seat.availableCollateral + seat.realizedPnl + unrealizedPnl(seat, markPrice);
}

/** `risk::is_liquidatable`. */
export function isLiquidatable(seat: SeatRiskInputs, markPrice: bigint, maintenanceBps: number): boolean {
  const positionNotional = notional(seat.basePosition < 0n ? -seat.basePosition : seat.basePosition, markPrice);
  const requirement = feeBps(positionNotional, maintenanceBps);
  return equity(seat, markPrice) < requirement;
}

/** `risk::partial_liquidation_quantity`: half the position, floor, minimum 1 -- only meaningful once `isLiquidatable` is true. */
export function partialLiquidationQuantity(seat: SeatRiskInputs): bigint {
  const abs = seat.basePosition < 0n ? -seat.basePosition : seat.basePosition;
  const half = abs / 2n;
  return half > 1n ? half : 1n;
}
