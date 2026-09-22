//! L1-owned, ER-readable authenticated oracle snapshot.
//!
//! The snapshot is deliberately not part of the 27-account delegated
//! execution bundle.  Pyth verification remains an L1 operation; ER paths
//! only read this fixed layout.  No Pyth treasury, storage, or fee account is
//! ever writable through the snapshot ABI.

use pinocchio::{error::ProgramError, Address, ProgramResult};

pub const ORACLE_SNAPSHOT_SIZE: usize = 128;
pub const ORACLE_SNAPSHOT_DISCRIMINATOR: [u8; 8] = *b"STKORS03";
pub const ORACLE_SNAPSHOT_VERSION: u16 = 3;

pub const OFFSET_VERSION: usize = 8;
pub const OFFSET_INITIALIZED: usize = 10;
pub const OFFSET_CORE: usize = 12;
pub const OFFSET_FEED_ID: usize = 44;
pub const OFFSET_CHANNEL: usize = 48;
pub const OFFSET_EXPONENT: usize = 49;
pub const OFFSET_PRICE: usize = 53;
pub const OFFSET_CONFIDENCE: usize = 61;
pub const OFFSET_PUBLISH_TIMESTAMP: usize = 69;
pub const OFFSET_SEQUENCE: usize = 77;
pub const OFFSET_SESSION: usize = 85;
pub const OFFSET_TRADING_STATUS: usize = 86;
pub const OFFSET_AUTHENTICATED: usize = 87;
pub const OFFSET_REVISION: usize = 88;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_HALTED: u8 = 1;
pub const STATUS_RESTRICTED: u8 = 2;
pub const STATUS_CLOSED: u8 = 3;

pub fn validate(bytes: &[u8], core: &Address, now: u64) -> ProgramResult {
    if bytes.len() != ORACLE_SNAPSHOT_SIZE
        || bytes[0..8] != ORACLE_SNAPSHOT_DISCRIMINATOR
        || u16::from_le_bytes(
            bytes[OFFSET_VERSION..OFFSET_VERSION + 2]
                .try_into()
                .unwrap(),
        ) != ORACLE_SNAPSHOT_VERSION
        || bytes[OFFSET_INITIALIZED] != 1
        || bytes[OFFSET_CORE..OFFSET_CORE + 32] != core.to_bytes()
        || bytes[OFFSET_AUTHENTICATED] != 1
        || bytes[OFFSET_REVISION] != 1
        || bytes[OFFSET_TRADING_STATUS] != STATUS_OPEN
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let price = i64::from_le_bytes(bytes[OFFSET_PRICE..OFFSET_PRICE + 8].try_into().unwrap());
    let confidence = u64::from_le_bytes(
        bytes[OFFSET_CONFIDENCE..OFFSET_CONFIDENCE + 8]
            .try_into()
            .unwrap(),
    );
    let timestamp = u64::from_le_bytes(
        bytes[OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8]
            .try_into()
            .unwrap(),
    );
    let sequence = u64::from_le_bytes(
        bytes[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8]
            .try_into()
            .unwrap(),
    );
    if sequence == 0
        || price <= 0
        || confidence > price.unsigned_abs() / 5
        || timestamp > now.saturating_add(2)
        || now > timestamp.saturating_add(10)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

pub fn validate_for_core(
    bytes: &[u8],
    core: &Address,
    feed_id: u32,
    channel: u8,
    exponent: i32,
    now: u64,
) -> ProgramResult {
    validate(bytes, core, now)?;
    if u32::from_le_bytes(
        bytes[OFFSET_FEED_ID..OFFSET_FEED_ID + 4]
            .try_into()
            .unwrap(),
    ) != feed_id
        || bytes[OFFSET_CHANNEL] != channel
        || i32::from_le_bytes(
            bytes[OFFSET_EXPONENT..OFFSET_EXPONENT + 4]
                .try_into()
                .unwrap(),
        ) != exponent
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

pub fn validate_writer(core_bytes: &[u8], writer: &Address) -> ProgramResult {
    if core_bytes.len() < 76 || core_bytes[44..76] != writer.to_bytes() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

pub fn initialize(
    bytes: &mut [u8],
    core: &Address,
    feed_id: u32,
    channel: u8,
    exponent: i32,
) -> ProgramResult {
    if bytes.len() != ORACLE_SNAPSHOT_SIZE
        || feed_id == 0
        || !(1..=4).contains(&channel)
        || !(-12..=0).contains(&exponent)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    bytes.fill(0);
    bytes[0..8].copy_from_slice(&ORACLE_SNAPSHOT_DISCRIMINATOR);
    bytes[OFFSET_VERSION..OFFSET_VERSION + 2]
        .copy_from_slice(&ORACLE_SNAPSHOT_VERSION.to_le_bytes());
    bytes[OFFSET_INITIALIZED] = 1;
    bytes[OFFSET_REVISION] = 1;
    bytes[OFFSET_CORE..OFFSET_CORE + 32].copy_from_slice(&core.to_bytes());
    bytes[OFFSET_FEED_ID..OFFSET_FEED_ID + 4].copy_from_slice(&feed_id.to_le_bytes());
    bytes[OFFSET_CHANNEL] = channel;
    bytes[OFFSET_EXPONENT..OFFSET_EXPONENT + 4].copy_from_slice(&exponent.to_le_bytes());
    Ok(())
}

/// Materializes one authenticated Pyth result into the fixed snapshot layout.
/// Pyth signature verification and core metadata checks happen in the caller;
/// this helper owns only the byte-level snapshot invariants and replay gate.
pub fn write_verified(
    bytes: &mut [u8],
    core: &Address,
    feed_id: u32,
    channel: u8,
    exponent: i32,
    price: i64,
    confidence: u64,
    publish_timestamp: u64,
    session: u8,
    now: u64,
) -> ProgramResult {
    if price <= 0
        || confidence > price.unsigned_abs() / 5
        || publish_timestamp > now.saturating_add(2)
        || now > publish_timestamp.saturating_add(10)
        || !matches!(session, 0..=4)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut sequence = 1u64;
    if bytes.len() == ORACLE_SNAPSHOT_SIZE
        && bytes[0..8] == ORACLE_SNAPSHOT_DISCRIMINATOR
        && bytes[OFFSET_INITIALIZED] == 1
    {
        let previous_timestamp = u64::from_le_bytes(
            bytes[OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8]
                .try_into()
                .unwrap(),
        );
        if publish_timestamp <= previous_timestamp {
            return Err(ProgramError::InvalidInstructionData);
        }
        sequence = u64::from_le_bytes(
            bytes[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8]
                .try_into()
                .unwrap(),
        )
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    initialize(bytes, core, feed_id, channel, exponent)?;
    bytes[OFFSET_PRICE..OFFSET_PRICE + 8].copy_from_slice(&price.to_le_bytes());
    bytes[OFFSET_CONFIDENCE..OFFSET_CONFIDENCE + 8].copy_from_slice(&confidence.to_le_bytes());
    bytes[OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8]
        .copy_from_slice(&publish_timestamp.to_le_bytes());
    bytes[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&sequence.to_le_bytes());
    bytes[OFFSET_SESSION] = session;
    bytes[OFFSET_TRADING_STATUS] = match session {
        0..=2 => STATUS_OPEN,
        3..=4 => STATUS_CLOSED,
        _ => unreachable!(),
    };
    bytes[OFFSET_AUTHENTICATED] = 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_is_fixed_and_non_overlapping() {
        assert_eq!(ORACLE_SNAPSHOT_SIZE, 128);
        assert_eq!(OFFSET_AUTHENTICATED + 1, 88);
        assert!(OFFSET_CORE + 32 <= OFFSET_FEED_ID);
        assert!(OFFSET_FEED_ID + 4 <= OFFSET_CHANNEL);
    }

    #[test]
    fn freshness_and_status_fail_closed() {
        let core = Address::new_from_array([7; 32]);
        let mut bytes = [0u8; ORACLE_SNAPSHOT_SIZE];
        initialize(&mut bytes, &core, 1435, 2, -5).unwrap();
        bytes[OFFSET_PRICE..OFFSET_PRICE + 8].copy_from_slice(&100_i64.to_le_bytes());
        bytes[OFFSET_CONFIDENCE..OFFSET_CONFIDENCE + 8].copy_from_slice(&10_u64.to_le_bytes());
        bytes[OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8]
            .copy_from_slice(&1_000_u64.to_le_bytes());
        bytes[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8].copy_from_slice(&1_u64.to_le_bytes());
        bytes[OFFSET_AUTHENTICATED] = 1;
        bytes[OFFSET_TRADING_STATUS] = STATUS_OPEN;
        assert!(validate_for_core(&bytes, &core, 1435, 2, -5, 1_005).is_ok());
        assert!(validate_for_core(&bytes, &core, 922, 2, -5, 1_005).is_err());
        assert!(validate_for_core(&bytes, &core, 1435, 2, -5, 1_011).is_err());
        bytes[OFFSET_TRADING_STATUS] = STATUS_HALTED;
        assert!(validate_for_core(&bytes, &core, 1435, 2, -5, 1_005).is_err());
        for status in [STATUS_RESTRICTED, STATUS_CLOSED] {
            bytes[OFFSET_TRADING_STATUS] = status;
            assert!(validate_for_core(&bytes, &core, 1435, 2, -5, 1_005).is_err());
        }
    }

    #[test]
    fn writer_is_bound_to_core_authority() {
        let mut core = [0u8; 76];
        let authority = Address::new_from_array([9; 32]);
        core[44..76].copy_from_slice(&authority.to_bytes());
        assert!(validate_writer(&core, &authority).is_ok());
        assert!(validate_writer(&core, &Address::new_from_array([8; 32])).is_err());
    }

    #[test]
    fn verified_write_round_trips_and_rejects_replay() {
        let core = Address::new_from_array([7; 32]);
        let mut bytes = [0u8; ORACLE_SNAPSHOT_SIZE];
        write_verified(
            &mut bytes, &core, 1435, 2, -5, 36982565, 10, 1_000, 1, 1_005,
        )
        .unwrap();
        assert!(validate_for_core(&bytes, &core, 1435, 2, -5, 1_005).is_ok());
        assert!(
            write_verified(&mut bytes, &core, 1435, 2, -5, 36982566, 10, 1_000, 1, 1_005).is_err()
        );
        write_verified(
            &mut bytes, &core, 1435, 2, -5, 36982566, 10, 1_001, 1, 1_005,
        )
        .unwrap();
        assert_eq!(
            u64::from_le_bytes(
                bytes[OFFSET_SEQUENCE..OFFSET_SEQUENCE + 8]
                    .try_into()
                    .unwrap()
            ),
            2
        );
    }
}
