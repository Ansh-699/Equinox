//! Diagnostics-only decoder for MagicBlock's 144-byte Pyth Lazer account.
//!
//! This is intentionally not used by V3 risk or matching. The account does
//! not contain StockStream's channel, market-session, trading-status, or
//! snapshot-sequence fields. A future reviewed adapter may build on this
//! decoder only after those missing bindings are supplied and tested.

use pinocchio::{error::ProgramError, Address};

pub const PRICE_UPDATE_V3_SIZE: usize = 144;
pub const VERIFICATION_LEVEL_OFFSET: usize = 40;
pub const FEED_ID_OFFSET: usize = 41;
pub const PRICE_OFFSET: usize = 73;
pub const CONFIDENCE_OFFSET: usize = 81;
pub const EXPONENT_OFFSET: usize = 89;
pub const PUBLISH_TIME_OFFSET: usize = 93;
pub const POSTED_SLOT_OFFSET: usize = 125;
pub const FULL_VERIFICATION_LEVEL: u8 = 1;

/// Values available in the external account, without pretending they form a
/// complete StockStream observation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MagicBlockPriceObservation {
    pub price: i64,
    pub confidence: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub posted_slot: u64,
}

/// Derive the canonical MagicBlock Pyth Lazer account for a numeric feed ID.
pub fn derive_price_feed(oracle_program: &Address, feed_id_text: &[u8]) -> Address {
    Address::find_program_address(
        &[b"price_feed", b"pyth-lazer", feed_id_text],
        oracle_program,
    )
    .0
}

/// Decode and validate only the fields that the external account actually
/// provides. This function is diagnostics-only and must not be called by a
/// risk, matching, funding, liquidation, or withdrawal path.
pub fn decode_price_only(
    account: &Address,
    owner: &Address,
    oracle_program: &Address,
    bytes: &[u8],
    feed_id_text: &[u8],
    expected_feed_bytes: &[u8; 32],
    expected_exponent: i32,
    now: u64,
) -> Result<MagicBlockPriceObservation, ProgramError> {
    if *owner != *oracle_program
        || *account != derive_price_feed(oracle_program, feed_id_text)
        || bytes.len() != PRICE_UPDATE_V3_SIZE
        || bytes[VERIFICATION_LEVEL_OFFSET] != FULL_VERIFICATION_LEVEL
        || bytes[FEED_ID_OFFSET..FEED_ID_OFFSET + 32] != expected_feed_bytes[..]
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let price = i64::from_le_bytes(bytes[PRICE_OFFSET..PRICE_OFFSET + 8].try_into().unwrap());
    let confidence = u64::from_le_bytes(
        bytes[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    let exponent = i32::from_le_bytes(
        bytes[EXPONENT_OFFSET..EXPONENT_OFFSET + 4]
            .try_into()
            .unwrap(),
    );
    let publish_time = i64::from_le_bytes(
        bytes[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    let posted_slot = u64::from_le_bytes(
        bytes[POSTED_SLOT_OFFSET..POSTED_SLOT_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    if exponent != expected_exponent
        || price <= 0
        || confidence > price.unsigned_abs() / 5
        || publish_time < 0
        || publish_time as u64 > now.saturating_add(2)
        || now > (publish_time as u64).saturating_add(10)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(MagicBlockPriceObservation {
        price,
        confidence,
        exponent,
        publish_time,
        posted_slot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Address, Address, [u8; 32], [u8; PRICE_UPDATE_V3_SIZE]) {
        let oracle = Address::new_from_array([8; 32]);
        let feed = [9; 32];
        let account = derive_price_feed(&oracle, b"1435");
        let mut bytes = [0u8; PRICE_UPDATE_V3_SIZE];
        bytes[VERIFICATION_LEVEL_OFFSET] = FULL_VERIFICATION_LEVEL;
        bytes[FEED_ID_OFFSET..FEED_ID_OFFSET + 32].copy_from_slice(&feed);
        bytes[PRICE_OFFSET..PRICE_OFFSET + 8].copy_from_slice(&100_i64.to_le_bytes());
        bytes[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8].copy_from_slice(&1_u64.to_le_bytes());
        bytes[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&(-5_i32).to_le_bytes());
        bytes[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
            .copy_from_slice(&1_000_u64.to_le_bytes());
        bytes[POSTED_SLOT_OFFSET..POSTED_SLOT_OFFSET + 8].copy_from_slice(&77_u64.to_le_bytes());
        (oracle, account, feed, bytes)
    }

    #[test]
    fn exact_external_layout_decodes_only_price_fields() {
        let (oracle, account, feed, bytes) = fixture();
        let decoded = decode_price_only(
            &account, &oracle, &oracle, &bytes, b"1435", &feed, -5, 1_005,
        )
        .unwrap();
        assert_eq!(decoded.price, 100);
        assert_eq!(decoded.posted_slot, 77);
    }

    #[test]
    fn wrong_owner_pda_feed_exponent_and_freshness_fail_closed() {
        let (oracle, account, feed, mut bytes) = fixture();
        assert!(decode_price_only(
            &account,
            &Address::new_from_array([7; 32]),
            &oracle,
            &bytes,
            b"1435",
            &feed,
            -5,
            1_005,
        )
        .is_err());
        bytes[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&(5_i32).to_le_bytes());
        assert!(
            decode_price_only(&account, &oracle, &oracle, &bytes, b"1435", &feed, -5, 1_005)
                .is_err()
        );
        bytes[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&(-5_i32).to_le_bytes());
        bytes[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8].copy_from_slice(&900_u64.to_le_bytes());
        assert!(
            decode_price_only(&account, &oracle, &oracle, &bytes, b"1435", &feed, -5, 1_005)
                .is_err()
        );
    }
}
