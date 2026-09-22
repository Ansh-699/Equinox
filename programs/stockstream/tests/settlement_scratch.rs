use pinocchio::Address;
use stockstream::{
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchHeader, SettlementScratchView,
        SETTLEMENT_PLAN_OFFSET, SETTLEMENT_PLAN_SIZE, SETTLEMENT_SCRATCH_ALIGNMENT,
        SETTLEMENT_SCRATCH_HEADER_PHYSICAL_SIZE, SETTLEMENT_SCRATCH_HEADER_SIZE,
        SETTLEMENT_SCRATCH_LEN,
    },
    ID,
};

fn scratch_bytes() -> Vec<u8> {
    vec![0; SETTLEMENT_SCRATCH_LEN]
}

#[test]
fn scratch_layout_is_bounded_and_reusable() {
    let market = Address::new_from_array([1; 32]);
    let trader = [2; 32];
    let mut bytes = scratch_bytes();
    let mut scratch = SettlementScratchView::new(&mut bytes).unwrap();
    scratch.initialize(market.to_bytes(), trader, 7);
    assert_eq!(scratch.read_header().status, ScratchStatus::Empty as u8);
    assert_eq!(scratch.begin(market.to_bytes(), trader, 7).unwrap(), 1);
    assert_eq!(scratch.read_header().status, ScratchStatus::Planning as u8);
    scratch.clear();
    let header = scratch.read_header();
    let nonce = header.plan_nonce;
    let plan_byte_len = header.plan_byte_len;
    assert_eq!(header.status, ScratchStatus::Empty as u8);
    assert_eq!(nonce, 1);
    assert_eq!(plan_byte_len as usize, SETTLEMENT_PLAN_SIZE);
}

#[test]
fn scratch_rejects_wrong_binding_and_non_empty_reuse() {
    let market = Address::new_from_array([3; 32]);
    let trader = [4; 32];
    let mut bytes = scratch_bytes();
    let mut scratch = SettlementScratchView::new(&mut bytes).unwrap();
    scratch.initialize(market.to_bytes(), trader, 1);
    assert!(scratch.begin(market.to_bytes(), [5; 32], 1).is_err());
    scratch.begin(market.to_bytes(), trader, 1).unwrap();
    assert!(scratch.begin(market.to_bytes(), trader, 1).is_err());
}

#[test]
fn scratch_header_detects_invalid_counts_and_plan_length() {
    let mut header = SettlementScratchHeader::empty([1; 32], [2; 32], 0);
    header.fill_count = 5;
    assert!(!header.validate([1; 32], [2; 32], 0));
    header.fill_count = 0;
    header.plan_byte_len = 0;
    assert!(!header.validate([1; 32], [2; 32], 0));
}

#[test]
fn scratch_pda_is_market_and_seat_scoped() {
    let market = Address::new_from_array([6; 32]);
    let first = derive_settlement_scratch(&market, 0, &ID);
    let second = derive_settlement_scratch(&market, 1, &ID);
    assert_ne!(first, second);
}

#[test]
fn scratch_regions_are_physically_aligned() {
    assert_eq!(SETTLEMENT_SCRATCH_HEADER_SIZE, 266);
    assert_eq!(SETTLEMENT_SCRATCH_HEADER_PHYSICAL_SIZE, 272);
    assert_eq!(SETTLEMENT_PLAN_OFFSET % SETTLEMENT_SCRATCH_ALIGNMENT, 0);
    assert_eq!(SETTLEMENT_SCRATCH_LEN % SETTLEMENT_SCRATCH_ALIGNMENT, 0);
}

#[test]
fn rust_client_and_pda_derivation_use_the_canonical_program_id() {
    const EXPECTED: Address = Address::new_from_array([
        1, 234, 74, 20, 133, 113, 141, 20, 242, 15, 253, 116, 227, 98, 23, 21, 74, 231, 252, 113,
        229, 226, 164, 31, 131, 3, 31, 153, 255, 39, 114, 192,
    ]);
    assert_eq!(ID, EXPECTED);
    assert!(
        include_str!("../../../clients/stockstream/src/constants.ts")
            .contains("8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ")
    );
    let market = Address::new_from_array([9; 32]);
    assert_ne!(
        derive_settlement_scratch(&market, 0, &ID),
        derive_settlement_scratch(&market, 0, &Address::new_from_array([8; 32]))
    );
}
