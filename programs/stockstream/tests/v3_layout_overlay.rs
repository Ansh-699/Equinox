use core::mem::{offset_of, size_of};
use std::str::FromStr;
use stockstream::v3::*;

fn validator() -> [u8; 32] {
    pinocchio::Address::from_str("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57")
        .unwrap()
        .to_bytes()
}

#[test]
fn legacy_overlap_is_reproduced_not_suppressed() {
    let mut bytes = [0u8; V3_MARKET_CORE_SIZE];
    bytes[226..228].copy_from_slice(&5u16.to_le_bytes());
    bytes[214..246].copy_from_slice(&validator());
    assert_eq!(
        u16::from_le_bytes(bytes[226..228].try_into().unwrap()),
        19144
    );
    assert_ne!(u16::from_le_bytes(bytes[226..228].try_into().unwrap()), 5);
}

#[test]
fn validator_overlay_preserves_all_economic_and_oracle_bytes() {
    let mut bytes = [0u8; V3_MARKET_CORE_SIZE];
    bytes[..8].copy_from_slice(&V3_MARKET_CORE_DISCRIMINATOR);
    bytes[8..10].copy_from_slice(&V3_LAYOUT_VERSION.to_le_bytes());
    bytes[10] = 1;
    bytes[11] = 1;
    bytes[180] = 1;
    bytes[181..189].copy_from_slice(&36982565i64.to_le_bytes());
    bytes[189..197].copy_from_slice(&1700000000u64.to_le_bytes());
    bytes[246..250].copy_from_slice(&1435u32.to_le_bytes());
    bytes[250] = 2;
    bytes[251..255].copy_from_slice(&(-5i32).to_le_bytes());
    initialize_v3_risk_config(&mut bytes).unwrap();
    let config = read_v3_risk_config(&bytes).unwrap();
    let before = bytes;
    bytes[V3_CORE_VALIDATOR_OFFSET..V3_CORE_VALIDATOR_OFFSET + 32].copy_from_slice(&validator());
    assert_eq!(read_v3_risk_config(&bytes).unwrap(), config);
    assert_eq!(&bytes[..214], &before[..214]);
    assert_eq!(&bytes[246..], &before[246..]);
    for offset in [
        V3_CORE_INITIAL_MARGIN_BPS_OFFSET,
        V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET,
        V3_CORE_LIQUIDATION_FEE_BPS_OFFSET,
        V3_CORE_MAKER_FEE_BPS_OFFSET,
        V3_CORE_TAKER_FEE_BPS_OFFSET,
        V3_CORE_MAXIMUM_LEVERAGE_OFFSET,
    ] {
        assert!(offset >= 246);
    }
    assert_eq!(V3_MARKET_CORE_SIZE, 4096);
    assert_eq!(offset_of!(MarketCoreV3, delegation_validator), 214);
    assert_eq!(offset_of!(MarketCoreV3, reserved), 246);
    assert_eq!(size_of::<MarketCoreV3>(), 4096);
    let decoded = unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast::<MarketCoreV3>()) };
    assert_eq!(decoded.discriminator, V3_MARKET_CORE_DISCRIMINATOR);
    assert_eq!(decoded.delegation_validator, validator());
    let roundtrip = unsafe {
        core::slice::from_raw_parts((&decoded as *const MarketCoreV3).cast::<u8>(), 4096)
    };
    assert_eq!(roundtrip, bytes);
    if let Ok(path) = std::env::var("V3_LAYOUT_FIXTURE_OUTPUT") {
        std::fs::write(
            path,
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        )
        .unwrap();
    }
    bytes[371] = 1;
    assert!(read_v3_risk_config(&bytes).is_err());
}

#[test]
fn freshness_checks_clock_session_confidence_and_price() {
    let mut bytes = [0; 4096];
    bytes[11] = 1;
    bytes[180] = 1;
    bytes[181..189].copy_from_slice(&100i64.to_le_bytes());
    bytes[189..197].copy_from_slice(&100u64.to_le_bytes());
    assert!(validate_v3_oracle_freshness(&bytes, 110).is_ok());
    assert!(validate_v3_oracle_freshness(&bytes, 111).is_err());
    assert!(validate_v3_oracle_freshness(&bytes, 97).is_err());
    for mode in [0, 2, 3, 4] {
        bytes[11] = mode;
        assert!(validate_v3_oracle_freshness(&bytes, 100).is_err());
    }
    bytes[11] = 1;
    for session in [3, 4, 255] {
        bytes[V3_CORE_ORACLE_SESSION_OFFSET] = session;
        assert!(validate_v3_oracle_freshness(&bytes, 100).is_err());
    }
    bytes[V3_CORE_ORACLE_SESSION_OFFSET] = 0;
    bytes[V3_CORE_ORACLE_CONFIDENCE_OFFSET..V3_CORE_ORACLE_CONFIDENCE_OFFSET + 8]
        .copy_from_slice(&21u64.to_le_bytes());
    assert!(validate_v3_oracle_freshness(&bytes, 100).is_err());
}
