//! Diagnostics-only decoder for MagicBlock's 144-byte Pyth Lazer account.
//!
//! This is intentionally not used by V3 risk or matching. The account does
//! not contain Equinox's channel, market-session, trading-status, or
//! snapshot-sequence fields, its confidence is never written upstream, and its
//! "Full" verification level is hard-coded by the writer program rather than
//! derived from an onchain Pyth signature check. A future reviewed adapter may
//! build on this decoder only after those missing bindings are supplied.
//!
//! Wire contract (magicblock-labs/real-time-pricing-oracle @ c6d08ac, verified
//! against live ER bytes on 2026-09-22): Anchor `PriceUpdateV3` =
//! discriminator, write authority, Borsh `VerificationLevel::Full` (1 byte),
//! `PriceFeedMessage`, posted slot, zero padding to 144 bytes.

use pinocchio::{error::ProgramError, Address};

pub const PRICE_UPDATE_V3_SIZE: usize = 144;
/// sha256("account:PriceUpdateV3")[..8].
pub const PRICE_UPDATE_V3_DISCRIMINATOR: [u8; 8] = [0xea, 0xa1, 0x0e, 0x24, 0xac, 0xef, 0x0f, 0xe8];
pub const WRITE_AUTHORITY_OFFSET: usize = 8;
pub const VERIFICATION_LEVEL_OFFSET: usize = 40;
/// Upstream stores the feed PDA's own address here, not the Lazer feed ID.
pub const FEED_ID_OFFSET: usize = 41;
pub const PRICE_OFFSET: usize = 73;
pub const CONFIDENCE_OFFSET: usize = 81;
pub const EXPONENT_OFFSET: usize = 89;
pub const PUBLISH_TIME_OFFSET: usize = 93;
pub const POSTED_SLOT_OFFSET: usize = 125;
pub const FULL_VERIFICATION_LEVEL: u8 = 1;

/// `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`.
pub const MAGICBLOCK_ORACLE_PROGRAM_ID: Address = Address::new_from_array([
    5, 218, 252, 72, 156, 177, 13, 59, 4, 178, 86, 42, 121, 202, 127, 199, 135, 199, 242, 98, 32,
    175, 163, 61, 134, 254, 228, 82, 83, 10, 52, 230,
]);
/// `MPUxHCpNUy3K1CSVhebAmTbcTCKVxfk9YMDcUP2ZnEA`, the only signer the
/// upstream program accepts for updates. `initialize_price_feed` is
/// permissionless, so the stored write authority must also be this key or a
/// third party may have chosen the exponent.
pub const MAGICBLOCK_ORACLE_IDENTITY: Address = Address::new_from_array([
    5, 57, 9, 94, 212, 224, 13, 229, 230, 129, 100, 43, 23, 187, 179, 117, 188, 120, 116, 232, 160,
    219, 186, 249, 18, 140, 4, 252, 140, 48, 152, 95,
]);

/// Values available in the external account, without pretending they form a
/// complete Equinox observation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MagicBlockPriceObservation {
    pub price: i64,
    pub confidence: u64,
    /// Canonical Pyth-signed exponent (e.g. -5), never the stored value.
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
///
/// Exponent rule: the upstream program's consumer (`sample`) scales by
/// `10^-exponent`, and every live ER feed stores `-catalog_exponent`
/// (BTC/ETH/SOL 8, AAPL/NVDA/TSLA 5). Only that exact value is accepted; a
/// Pyth-signed value or any other magnitude fails closed.
pub fn decode_price_only(
    account: &Address,
    owner: &Address,
    bytes: &[u8],
    feed_id_text: &[u8],
    expected_exponent: i32,
    now: u64,
) -> Result<MagicBlockPriceObservation, ProgramError> {
    if *owner != MAGICBLOCK_ORACLE_PROGRAM_ID
        || *account != derive_price_feed(&MAGICBLOCK_ORACLE_PROGRAM_ID, feed_id_text)
        || bytes.len() != PRICE_UPDATE_V3_SIZE
        || bytes[..8] != PRICE_UPDATE_V3_DISCRIMINATOR
        || bytes[WRITE_AUTHORITY_OFFSET..WRITE_AUTHORITY_OFFSET + 32]
            != MAGICBLOCK_ORACLE_IDENTITY.to_bytes()
        || bytes[VERIFICATION_LEVEL_OFFSET] != FULL_VERIFICATION_LEVEL
        || bytes[FEED_ID_OFFSET..FEED_ID_OFFSET + 32] != account.to_bytes()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let price = i64::from_le_bytes(bytes[PRICE_OFFSET..PRICE_OFFSET + 8].try_into().unwrap());
    let confidence = u64::from_le_bytes(
        bytes[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    let stored_decimals = i32::from_le_bytes(
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
    // Upstream never writes confidence, so zero means "not published".
    if expected_exponent >= 0
        || stored_decimals != expected_exponent.wrapping_neg()
        || price <= 0
        || confidence == 0
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
        exponent: expected_exponent,
        publish_time,
        posted_slot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed 1435 read from devnet-as.magicblock.app at slot 612511129.
    const LIVE_ER_HEX: &str = "eaa10e24acef0fe80539095ed4e00de5e681642b17bbb375bc7874e8a0dbbaf9128c04fc8c30985f016ce7527dde6dcbc54b7aedfc80a5025265f2cd2fae2ad2b44cf5bc9da2be0f9be7d041020000000000000000000000000500000092b7b26a0000000091b7b26a0000000000000000000000000000000000000000982d8224000000000000000000000000000000";
    /// The same PDA's stale delegated copy on devnet L1 at slot 502527977.
    const STALE_L1_HEX: &str = "eaa10e24acef0fe80539095ed4e00de5e681642b17bbb375bc7874e8a0dbbaf9128c04fc8c30985f016ce7527dde6dcbc54b7aedfc80a5025265f2cd2fae2ad2b44cf5bc9da2be0f9b0000000000000000000000000000000008000000fbf1b26900000000fbf1b269000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const LIVE_PUBLISH: u64 = 1_790_097_298;

    fn hex(s: &str) -> [u8; PRICE_UPDATE_V3_SIZE] {
        let mut out = [0u8; PRICE_UPDATE_V3_SIZE];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    fn account() -> Address {
        derive_price_feed(&MAGICBLOCK_ORACLE_PROGRAM_ID, b"1435")
    }

    fn decode(bytes: &[u8]) -> Result<MagicBlockPriceObservation, ProgramError> {
        decode_price_only(
            &account(),
            &MAGICBLOCK_ORACLE_PROGRAM_ID,
            bytes,
            b"1435",
            -5,
            LIVE_PUBLISH + 1,
        )
    }

    /// Live bytes with a synthetic confidence, isolating every other check.
    fn with_confidence() -> [u8; PRICE_UPDATE_V3_SIZE] {
        let mut bytes = hex(LIVE_ER_HEX);
        bytes[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8].copy_from_slice(&100_u64.to_le_bytes());
        bytes
    }

    #[test]
    fn live_pda_derivation_and_feed_binding_match() {
        let bytes = hex(LIVE_ER_HEX);
        assert_eq!(
            bytes[FEED_ID_OFFSET..FEED_ID_OFFSET + 32],
            account().to_bytes()
        );
        assert_eq!(
            bytes[WRITE_AUTHORITY_OFFSET..WRITE_AUTHORITY_OFFSET + 32],
            MAGICBLOCK_ORACLE_IDENTITY.to_bytes()
        );
    }

    #[test]
    fn live_stored_five_decodes_to_canonical_minus_five() {
        let decoded = decode(&with_confidence()).unwrap();
        assert_eq!(decoded.exponent, -5);
        assert_eq!(decoded.price, 37_867_751); // $378.67751
        assert_eq!(decoded.publish_time as u64, LIVE_PUBLISH);
        assert_eq!(decoded.posted_slot, 612_511_128);
    }

    #[test]
    fn live_bytes_fail_closed_because_confidence_is_never_published() {
        assert!(decode(&hex(LIVE_ER_HEX)).is_err());
    }

    #[test]
    fn only_the_exact_negated_exponent_is_accepted() {
        for stored in [-5_i32, 8, 4, 6, 0] {
            let mut bytes = with_confidence();
            bytes[EXPONENT_OFFSET..EXPONENT_OFFSET + 4].copy_from_slice(&stored.to_le_bytes());
            assert!(decode(&bytes).is_err(), "stored exponent {stored}");
        }
        // A non-negative canonical expectation is never valid.
        let bytes = with_confidence();
        assert!(decode_price_only(
            &account(),
            &MAGICBLOCK_ORACLE_PROGRAM_ID,
            &bytes,
            b"1435",
            5,
            LIVE_PUBLISH
        )
        .is_err());
    }

    #[test]
    fn stale_l1_copy_is_rejected() {
        let mut bytes = hex(STALE_L1_HEX);
        bytes[CONFIDENCE_OFFSET..CONFIDENCE_OFFSET + 8].copy_from_slice(&1_u64.to_le_bytes());
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn wrong_owner_pda_writer_feed_and_freshness_fail_closed() {
        let bytes = with_confidence();
        let other = Address::new_from_array([7; 32]);
        assert!(decode_price_only(&account(), &other, &bytes, b"1435", -5, LIVE_PUBLISH).is_err());
        assert!(decode_price_only(
            &derive_price_feed(&MAGICBLOCK_ORACLE_PROGRAM_ID, b"922"),
            &MAGICBLOCK_ORACLE_PROGRAM_ID,
            &bytes,
            b"922",
            -5,
            LIVE_PUBLISH
        )
        .is_err());
        for offset in [
            0,
            WRITE_AUTHORITY_OFFSET,
            VERIFICATION_LEVEL_OFFSET,
            FEED_ID_OFFSET,
        ] {
            let mut tampered = bytes;
            tampered[offset] ^= 1;
            assert!(decode(&tampered).is_err(), "offset {offset}");
        }
        for now in [LIVE_PUBLISH + 11, LIVE_PUBLISH - 3] {
            assert!(decode_price_only(
                &account(),
                &MAGICBLOCK_ORACLE_PROGRAM_ID,
                &bytes,
                b"1435",
                -5,
                now
            )
            .is_err());
        }
    }
}
