use crate::state::{LiquidationState, TraderSeat};

pub const BPS_DENOMINATOR: i128 = 10_000;
pub const FUNDING_SCALE: i128 = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RiskError {
    Overflow,
    NegativeCollateral,
    PositionLimit,
    OpenInterestLimit,
    Margin,
    InvalidPrice,
}

fn add(a: i128, b: i128) -> Result<i128, RiskError> {
    a.checked_add(b).ok_or(RiskError::Overflow)
}
fn sub(a: i128, b: i128) -> Result<i128, RiskError> {
    a.checked_sub(b).ok_or(RiskError::Overflow)
}
fn mul(a: i128, b: i128) -> Result<i128, RiskError> {
    a.checked_mul(b).ok_or(RiskError::Overflow)
}
fn abs(a: i128) -> Result<i128, RiskError> {
    a.checked_abs().ok_or(RiskError::Overflow)
}

pub fn notional(quantity: i128, price: i128) -> Result<i128, RiskError> {
    if price <= 0 || quantity < 0 {
        return Err(RiskError::InvalidPrice);
    }
    mul(quantity, price)
}

pub fn fee(notional_value: i128, fee_bps: u16) -> Result<i128, RiskError> {
    mul(notional_value, fee_bps as i128)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(RiskError::Overflow)
}

pub fn apply_fill(
    seat: &mut TraderSeat,
    signed_quantity: i128,
    price: i128,
    fee_bps: u16,
) -> Result<i128, RiskError> {
    if price <= 0 {
        return Err(RiskError::InvalidPrice);
    }
    let old = seat.base_position;
    let old_abs = abs(old)?;
    let trade_abs = abs(signed_quantity)?;
    let trade_notional = notional(trade_abs, price)?;
    let charged_fee = fee(trade_notional, fee_bps)?;
    let mut realized = 0;
    if old == 0 || (old > 0 && signed_quantity > 0) || (old < 0 && signed_quantity < 0) {
        seat.base_position = add(old, signed_quantity)?;
        seat.quote_entry_value = add(seat.quote_entry_value, mul(signed_quantity, price)?)?;
    } else {
        let close_qty = old_abs.min(trade_abs);
        let direction = if old > 0 { 1 } else { -1 };
        let entry = if old_abs == 0 {
            0
        } else {
            seat.quote_entry_value
                .checked_div(old)
                .ok_or(RiskError::Overflow)?
        };
        realized = mul(mul(close_qty, sub(price, entry)?)?, direction)?;
        let remaining = sub(trade_abs, close_qty)?;
        if remaining == 0 {
            seat.base_position = if old > 0 {
                sub(old, close_qty)?
            } else {
                add(old, close_qty)?
            };
            seat.quote_entry_value = if seat.base_position == 0 {
                0
            } else {
                mul(seat.base_position, entry)?
            };
        } else {
            let new_direction = if signed_quantity > 0 { 1 } else { -1 };
            seat.base_position = mul(remaining, new_direction)?;
            seat.quote_entry_value = mul(mul(remaining, price)?, new_direction)?;
        }
    }
    seat.realized_pnl = sub(seat.realized_pnl, charged_fee)?;
    seat.realized_pnl = add(seat.realized_pnl, realized)?;
    Ok(charged_fee)
}

pub fn settle_funding(seat: &mut TraderSeat, accumulator: i128) -> Result<i128, RiskError> {
    let delta = sub(accumulator, seat.last_funding_accumulator)?;
    let payment = mul(seat.base_position, delta)?
        .checked_div(FUNDING_SCALE)
        .ok_or(RiskError::Overflow)?;
    seat.realized_pnl = sub(seat.realized_pnl, payment)?;
    seat.last_funding_accumulator = accumulator;
    Ok(payment)
}

pub fn unrealized_pnl(seat: &TraderSeat, mark_price: i128) -> Result<i128, RiskError> {
    if mark_price <= 0 {
        return Err(RiskError::InvalidPrice);
    }
    let current = mul(seat.base_position, mark_price)?;
    let entry = if seat.base_position == 0 {
        0
    } else {
        seat.quote_entry_value
    };
    sub(current, entry)
}

pub fn equity(seat: &TraderSeat, mark_price: i128) -> Result<i128, RiskError> {
    add(
        add(seat.available_collateral, seat.realized_pnl)?,
        unrealized_pnl(seat, mark_price)?,
    )
}

/// No governance instruction currently sets a per-market withdrawal buffer;
/// this is the documented placeholder value (`docs/risk.md`) that
/// `prepare_withdrawal` adds on top of the maintenance-margin and
/// reserved-order-margin requirement. Introducing a configurable buffer
/// later only means passing a non-zero value in from the market header,
/// not changing this formula.
pub const DEFAULT_WITHDRAWAL_BUFFER: i128 = 0;

/// Computes the post-withdrawal seat state, or rejects the withdrawal.
///
/// Withdrawal health: `post_withdraw_equity = equity - amount` must be
/// `>= maintenance_margin(|position|) + reserved_margin + withdrawal_buffer`.
/// `reserved_margin` already reflects the seat's worst-case resting-order
/// exposure (see `place_order_core`), so this does not double-count it.
/// `available_collateral` is also required to stay `>= 0` on its own: this
/// program never lets a withdrawal convert unrealized/realized PnL directly
/// into a token payout past the trader's actually-deposited collateral (see
/// `docs/risk.md` for why that is a deliberate, not accidental, limit of the
/// current immediate-settlement accounting model).
pub fn prepare_withdrawal(
    seat: &TraderSeat,
    amount: u64,
    funding_accumulator: i128,
    mark_price: i128,
    maintenance_bps: u16,
    withdrawal_buffer: i128,
) -> Result<TraderSeat, RiskError> {
    if amount == 0 || seat.reserved_margin < 0 || withdrawal_buffer < 0 {
        return Err(RiskError::Margin);
    }
    let mut result = *seat;
    settle_funding(&mut result, funding_accumulator)?;
    result.available_collateral = sub(result.available_collateral, i128::from(amount))?;
    if result.available_collateral < 0 {
        return Err(RiskError::NegativeCollateral);
    }
    let requirement = maintenance_margin(
        notional(abs(result.base_position)?, mark_price)?,
        maintenance_bps,
    )?;
    let required_total = add(add(requirement, result.reserved_margin)?, withdrawal_buffer)?;
    if equity(&result, mark_price)? < required_total {
        return Err(RiskError::Margin);
    }
    Ok(result)
}

pub fn initial_margin(notional_value: i128, margin_bps: u16) -> Result<i128, RiskError> {
    fee(notional_value, margin_bps)
}
pub fn maintenance_margin(notional_value: i128, margin_bps: u16) -> Result<i128, RiskError> {
    fee(notional_value, margin_bps)
}
pub fn available_margin(
    seat: &TraderSeat,
    mark_price: i128,
    initial_bps: u16,
) -> Result<i128, RiskError> {
    let used = initial_margin(notional(abs(seat.base_position)?, mark_price)?, initial_bps)?;
    sub(equity(seat, mark_price)?, add(used, seat.reserved_margin)?)
}

pub fn is_liquidatable(
    seat: &TraderSeat,
    mark_price: i128,
    maintenance_bps: u16,
) -> Result<bool, RiskError> {
    let requirement = maintenance_margin(
        notional(abs(seat.base_position)?, mark_price)?,
        maintenance_bps,
    )?;
    Ok(equity(seat, mark_price)? < requirement)
}

pub fn partial_liquidation_quantity(
    seat: &TraderSeat,
    mark_price: i128,
    maintenance_bps: u16,
) -> Result<i128, RiskError> {
    if !is_liquidatable(seat, mark_price, maintenance_bps)? {
        return Ok(0);
    }
    Ok(abs(seat.base_position)?.checked_div(2).unwrap_or(0).max(1))
}

pub fn set_liquidation_state(
    seat: &mut TraderSeat,
    mark_price: i128,
    maintenance_bps: u16,
) -> Result<(), RiskError> {
    seat.liquidation_state = if is_liquidatable(seat, mark_price, maintenance_bps)? {
        LiquidationState::Liquidatable as u8
    } else {
        LiquidationState::Healthy as u8
    };
    Ok(())
}
