//! Deterministic executable mark price, computed ON-CHAIN from the live
//! order book and the verified oracle -- never from caller-supplied
//! instruction data. A keeper cannot select an arbitrary funding rate or
//! liquidation price because the mark is derived here, inside the program,
//! from the same PATRICIA arenas the matcher executes against.
//!
//! Policy (deterministic integer math only):
//!
//! 1. The executable best bid and best ask are derived from the two real
//!    arena roots. Each side takes the better of its two tree roots' best
//!    leaf: the Fixed tree's `price_or_offset`, and the OraclePegged tree's
//!    evaluated pegged price (oracle + offset, valid only inside the peg
//!    limit -- `book::pegged_state`). Invalid (`quantity == 0`, expired,
//!    limit violated) and Skipped (oracle unavailable) pegged states are
//!    excluded from the mark. Expiry is honored through the same per-leaf
//!    `expires_at` check the matcher uses; the arenas'
//!    `child_earliest_expiry` caches keep the tree short.
//! 2. Two-sided book: mark = floor((best_bid + best_ask) / 2) -- integer
//!    division is the deterministic round-half-down rule for positive
//!    prices.
//! 3. One-sided book: the single executable price is the mark (the only
//!    price the book actually supports).
//! 4. Empty book (or a crossed book, which valid matching never leaves
//!    behind): mark falls back to the verified index. A stale/halted
//!    oracle (oracle unavailable) yields NO mark at all -- callers reject
//!    risk-increasing operations on `None`, never trade on a fallback.
//! 5. Clamp: a book-derived mark may not deviate from the verified index
//!    by more than `max_mark_deviation_bps` (default 500 = 5%; overridable
//!    per market via `state::RESERVED_MAX_MARK_DEVIATION_BPS`), so even
//!    extreme one-sided quoting cannot drag the mark away from the signed
//!    oracle price. The clamped value IS the mark (deterministic).
//!
//! Everything is `i128` arithmetic with checked operations and integer
//! division; there is no floating point and no rounding ambiguity.

use pinocchio::error::ProgramError;

use crate::{
    book::{pegged_state, Arena, PeggedState, Side, TreeKind},
    error::StockStreamError,
    state::MarketStateHeader,
};

fn custom(error: StockStreamError) -> ProgramError {
    error.into()
}

/// Default per-side clamp on a book-derived mark, in basis points from the
/// verified index (5%).
pub const DEFAULT_MAX_MARK_DEVIATION_BPS: i64 = 500;

/// Where a mark quote came from -- carried in the `MarkPriceUpdated` event
/// payload and mirrored in the Worker projection so a UI can show which
/// policy produced the number.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarkSource {
    /// Book is empty (or crossed): the verified index itself.
    Index = 0,
    /// Both sides executable: floor((bid + ask) / 2), clamped.
    BookMid = 1,
    /// One side executable: that side's price, clamped.
    BookOneSided = 2,
}

impl MarkSource {
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Index),
            1 => Some(Self::BookMid),
            2 => Some(Self::BookOneSided),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarkQuote {
    pub price: i64,
    pub source: MarkSource,
}

/// The better executable price on one side across both trees of one
/// arena... both trees of BOTH arenas. Bids live in the bid arena, asks in
/// the ask arena; each arena carries a Fixed tree (index 0) and an
/// OraclePegged tree (index 1). For a bid, the higher of the two tree
/// bests wins; for an ask, the lower.
fn best_executable_price(
    bid_arena: &Arena,
    ask_arena: &Arena,
    side: Side,
    oracle: Option<i64>,
    now: u64,
) -> Option<i64> {
    let mut best: Option<i64> = None;
    for (arena, trees) in [
        (bid_arena, [TreeKind::Fixed, TreeKind::OraclePegged]),
        (ask_arena, [TreeKind::Fixed, TreeKind::OraclePegged]),
    ] {
        for tree in trees {
            let handle = arena.best(tree).ok()?.and_then(|h| arena.leaf(h).ok());
            let Some(leaf) = handle else { continue };
            if leaf.quantity == 0 || leaf.expires_at <= now {
                continue;
            }
            let price = match tree {
                TreeKind::Fixed => leaf.price_or_offset,
                TreeKind::OraclePegged => match pegged_state(&leaf, oracle, now) {
                    // Valid pegged orders execute at oracle + offset.
                    PeggedState::Valid(price) => price,
                    // Skipped (stale oracle) and Invalid pegged orders
                    // cannot execute; they are never mark inputs.
                    PeggedState::Skipped | PeggedState::Invalid => continue,
                },
            };
            if leaf.side != side as u8 || price <= 0 {
                continue;
            }
            best = Some(match best {
                None => price,
                Some(current) => match side {
                    Side::Bid => current.max(price),
                    Side::Ask => current.min(price),
                },
            });
        }
    }
    best
}

/// Clamps `mark` into `[index * (1 - d), index * (1 + d)]` with d =
/// `max_mark_deviation_bps / 10_000`, using pure integer math (floor on
/// both bounds). Prices are strictly positive.
fn clamp_to_index(mark: i128, index: i64, max_deviation_bps: i64) -> i64 {
    let index128 = index as i128;
    let deviation = index128
        .checked_mul(max_deviation_bps as i128)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0);
    let lower = (index128 - deviation).max(1);
    let upper = index128 + deviation;
    mark.max(lower).min(upper) as i64
}

/// Computes the executable mark for a market from its two arenas plus the
/// header's verified-oracle state.
///
/// `oracle_price` must be `Some(verified_price)` only when
/// `header.oracle_valid == 1` and the market is not halted; with no
/// verified oracle (stale/halted/closed feed), this returns `Err` -- the
/// risk-increasing callers treat it exactly like their existing
/// `OracleUnavailable` guard, never like a price.
pub fn executable_mark(
    bid_arena: &Arena,
    ask_arena: &Arena,
    header: &MarketStateHeader,
    oracle_price: i64,
) -> Result<MarkQuote, ProgramError> {
    if header.oracle_valid != 1 {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    if header.mode != crate::state::MarketMode::Open as u8
        && header.mode != crate::state::MarketMode::CloseOnly as u8
        && header.mode != crate::state::MarketMode::Emergency as u8
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let index = header.last_verified_oracle_price;
    if index <= 0 || index != oracle_price {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let max_deviation = header.max_mark_deviation_bps();
    let now = header.last_verified_oracle_timestamp;
    let oracle = Some(index);
    let best_bid = best_executable_price(bid_arena, ask_arena, Side::Bid, oracle, now);
    let best_ask = best_executable_price(bid_arena, ask_arena, Side::Ask, oracle, now);
    let quote = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) if ask > bid => {
            let mid = (bid as i128 + ask as i128) / 2;
            MarkQuote {
                price: clamp_to_index(mid, index, max_deviation),
                source: MarkSource::BookMid,
            }
        }
        // Crossed or locked books: valid matching never leaves them behind;
        // fall back to the verified index (deterministic, safe).
        (Some(_), Some(_)) => MarkQuote {
            price: index,
            source: MarkSource::Index,
        },
        (Some(price), None) | (None, Some(price)) => MarkQuote {
            price: clamp_to_index(price as i128, index, max_deviation),
            source: MarkSource::BookOneSided,
        },
        (None, None) => MarkQuote {
            price: index,
            source: MarkSource::Index,
        },
    };
    Ok(quote)
}
