//! Market-oracle configuration helpers.
//!
//! Oracle configuration is copied from the reviewed registry into a newly
//! initialized market. Trading paths only consume the persisted values.

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::handlers::{initialized_header, market_data, write_header};

/// Copies reviewed registry oracle configuration into a newly initialized
/// market. Registry creation is the only path that may set a market's Pyth
/// Pro feed/channel; trading never accepts either value from callers.
pub(crate) fn configure_market_oracle(
    program_id: &Address,
    market: &mut AccountView,
    feed_id: u32,
    channel: u8,
    price_exponent: i32,
) -> ProgramResult {
    if feed_id == 0 || !(1..=4).contains(&channel) || !(-12..=0).contains(&price_exponent) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let data = market_data(market, program_id)?;
    let mut header = initialized_header(data)?;
    header.price_exponent = price_exponent;
    header.reserved_upgrade[64..68].copy_from_slice(&feed_id.to_le_bytes());
    header.reserved_upgrade[68] = channel;
    write_header(data, &header)
}
