use super::*;
use crate::state::MARKET_ACCOUNT_SIZE;

#[test]
fn v3_pages_preserve_capacity_and_fit_magicblock_commit_bounds() {
    assert!(v3_layout_is_committable());
    assert_eq!(V3_BOOK_SLOTS_PER_SIDE, 1_024);
    // Current MagicBlock scheduler source rejects an account whose data
    // grows by more than 10,240 bytes during a commit. Keep a margin below
    // that exact boundary; the next byte must be rejected locally.
    assert_eq!(V3_BOOK_PAGE_SIZE, 10_184);
    assert!(V3_BOOK_PAGE_SIZE < V3_COMMIT_ACCOUNT_SAFE_MAX);
    assert!(!committable_account_size(V3_COMMIT_ACCOUNT_SAFE_MAX + 1));
    assert!(V3_BOOK_PAGE_SIZE < V3_COMMIT_ACCOUNT_HARD_MAX);
}

#[test]
fn v2_monolith_is_rejected_by_v3_commit_layout_gate() {
    assert!(MARKET_ACCOUNT_SIZE > V3_COMMIT_ACCOUNT_HARD_MAX);
    assert!(!committable_account_size(MARKET_ACCOUNT_SIZE));
}

#[test]
fn v3_account_kinds_are_bounded_and_non_aliasing() {
    let id = Address::new_from_array([7; 32]);
    let market = derive_market_core_v3(&id, &Address::new_from_array([8; 32]));
    assert_eq!(V3AccountKind::BookPage.account_size(), V3_BOOK_PAGE_SIZE);
    assert!(derive_v3_account(&id, &market, V3AccountKind::BookPage, 18).is_none());
    assert_ne!(
        derive_v3_account(&id, &market, V3AccountKind::BookPage, 0),
        derive_v3_account(&id, &market, V3AccountKind::BookPage, 1)
    );
}

#[test]
fn v3_snapshot_records_cover_every_child_without_overlapping_risk_state() {
    assert_eq!(V3_CHILD_COUNT, 26);
    let first = child_record_offset(0).unwrap();
    let last = child_record_offset(V3_CHILD_COUNT - 1).unwrap();
    assert_eq!(first, V3_CORE_CHILD_RECORDS_OFFSET);
    assert_eq!(last + V3_CORE_CHILD_RECORD_SIZE, 1_640);
    assert!(child_record_offset(V3_CHILD_COUNT).is_none());
    assert_ne!(snapshot_digest(&[1, 2, 3]), snapshot_digest(&[1, 2, 4]));
}
