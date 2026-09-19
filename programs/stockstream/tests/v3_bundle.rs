//! Exact V3 execution-bundle account-order and alias validation.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    book::{LeafNode, Side, TreeKind},
    v3::{
        append_event_record, close_trader_seat, create_trader_seat, derive_book_page_v3,
        derive_event_shard_v3, derive_market_core_v3, derive_seat_shard_v3,
        initialize_book_page_metadata, validate_execution_bundle, PagedBookV3, V3_BOOK_PAGE_SIZE,
        V3_EVENT_SHARD_SIZE, V3_EXECUTION_BUNDLE_LEN, V3_MARKET_CORE_SIZE, V3_SEAT_SHARD_SIZE,
    },
    ID,
};

struct TestAccount {
    _storage: Vec<u64>,
    view: AccountView,
}
fn account(address: Address, size: usize, signer: bool) -> TestAccount {
    let words = (size_of::<RuntimeAccount>() + size).div_ceil(size_of::<u64>());
    let mut storage = vec![0u64; words];
    let raw = storage.as_mut_ptr() as *mut RuntimeAccount;
    unsafe {
        ptr::write(
            raw,
            RuntimeAccount {
                borrow_state: NOT_BORROWED,
                is_signer: signer as u8,
                is_writable: 1,
                executable: 0,
                padding: [0; 4],
                address,
                owner: ID,
                lamports: 1,
                data_len: size as u64,
            },
        );
    }
    TestAccount {
        _storage: storage,
        view: unsafe { AccountView::new_unchecked(raw) },
    }
}
fn header(account: &mut TestAccount, discriminator: &[u8; 8], index: u8, core: Option<Address>) {
    let bytes = unsafe { account.view.borrow_unchecked_mut() };
    bytes.fill(0);
    bytes[0..8].copy_from_slice(discriminator);
    bytes[8..10].copy_from_slice(&3u16.to_le_bytes());
    bytes[10] = index;
    if let Some(core) = core {
        bytes[12..44].copy_from_slice(core.as_ref());
    }
}
fn bundle() -> Vec<TestAccount> {
    let instrument = Address::new_from_array([8; 32]);
    let core_key = derive_market_core_v3(&ID, &instrument);
    let mut core = account(core_key, V3_MARKET_CORE_SIZE, false);
    header(&mut core, b"STKMK003", 1, Some(instrument));
    unsafe {
        core.view.borrow_unchecked_mut()[11] = 1;
    }
    let mut accounts = vec![core];
    for flat in 0..8u8 {
        let side = flat / 4;
        let page = flat % 4;
        let mut value = account(
            derive_book_page_v3(&ID, &core_key, side, page),
            V3_BOOK_PAGE_SIZE,
            false,
        );
        header(&mut value, b"STKBK003", side, Some(core_key));
        unsafe {
            value.view.borrow_unchecked_mut()[11] = page;
            initialize_book_page_metadata(value.view.borrow_unchecked_mut(), page).unwrap();
        }
        accounts.push(value);
    }
    for shard in 0..4u8 {
        let mut value = account(
            derive_seat_shard_v3(&ID, &core_key, shard),
            V3_SEAT_SHARD_SIZE,
            false,
        );
        header(&mut value, b"STKST003", shard, Some(core_key));
        accounts.push(value);
    }
    for shard in 0..4u8 {
        let mut value = account(
            derive_event_shard_v3(&ID, &core_key, shard),
            V3_EVENT_SHARD_SIZE,
            false,
        );
        header(&mut value, b"STKEV003", shard, Some(core_key));
        accounts.push(value);
    }
    accounts
}

fn leaf(key: u128, owner: u32) -> LeafNode {
    LeafNode {
        tag: 2,
        side: Side::Ask as u8,
        time_in_force: 0,
        _padding: 0,
        owner,
        key,
        quantity: 1,
        expires_at: u64::MAX,
        peg_limit: 0,
        client_order_id: owner as u64,
        price_or_offset: owner as i64,
        sequence: owner as u64,
        flags: 0,
        _reserved: [0; 15],
    }
}

fn expiring_leaf(key: u128, owner: u32, expires_at: u64) -> LeafNode {
    let mut value = leaf(key, owner);
    value.expires_at = expires_at;
    value
}
fn views(accounts: &[TestAccount]) -> Vec<AccountView> {
    accounts.iter().map(|value| value.view.clone()).collect()
}

#[test]
fn v3_bundle_requires_all_pages_shards_and_canonical_order() {
    let accounts = bundle();
    assert_eq!(accounts.len(), V3_EXECUTION_BUNDLE_LEN);
    assert!(validate_execution_bundle(&ID, &views(&accounts), true).is_ok());
    let mut reordered = views(&accounts);
    reordered.swap(1, 2);
    assert!(validate_execution_bundle(&ID, &reordered, true).is_err());
    assert!(validate_execution_bundle(&ID, &views(&accounts)[..16], true).is_err());
}

#[test]
fn v3_bundle_rejects_duplicate_substitution_and_foreign_parent() {
    let mut accounts = bundle();
    let mut duplicate = views(&accounts);
    duplicate[2] = duplicate[1].clone();
    assert!(validate_execution_bundle(&ID, &duplicate, true).is_err());
    unsafe {
        accounts[9].view.borrow_unchecked_mut()[12] ^= 1;
    }
    assert!(validate_execution_bundle(&ID, &views(&accounts), true).is_err());
}

#[test]
fn v3_seat_creation_uses_derived_shard_and_prevents_cross_shard_duplicates() {
    let accounts = bundle();
    let trader = account(Address::new_from_array([42; 32]), 0, true);
    let mut call = vec![
        accounts[0].view.clone(),
        accounts[9].view.clone(),
        accounts[10].view.clone(),
        accounts[11].view.clone(),
        accounts[12].view.clone(),
        accounts[13].view.clone(),
        accounts[14].view.clone(),
        accounts[15].view.clone(),
        accounts[16].view.clone(),
    ];
    call.push(trader.view.clone());
    create_trader_seat(&ID, &mut call, 32).expect("seat 32 lives in shard 1 slot 0");
    let occupied = unsafe { accounts[10].view.borrow_unchecked() };
    assert_eq!(occupied[44], 1);
    assert_eq!(&occupied[45..77], trader.view.address().as_ref());
    assert!(create_trader_seat(&ID, &mut call, 1).is_err());
    assert!(create_trader_seat(&ID, &mut call, 128).is_err());
    close_trader_seat(&ID, &mut call, 32).expect("empty seat closes");
    assert_eq!(unsafe { accounts[10].view.borrow_unchecked() }[44], 0);
    assert!(close_trader_seat(&ID, &mut call, 32).is_err());
    create_trader_seat(&ID, &mut call, 32).expect("closed seat can be reused");
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[148..156].try_into().unwrap()), 3);
}

#[test]
fn v3_paged_book_preserves_global_handles_across_page_boundaries() {
    let accounts = bundle();
    let mut pages = vec![
        accounts[1].view.clone(),
        accounts[2].view.clone(),
        accounts[3].view.clone(),
        accounts[4].view.clone(),
    ];
    let mut book = PagedBookV3::new(&mut pages).unwrap();
    for index in 0..129u128 {
        let key = index << 64;
        book.insert(TreeKind::Fixed, leaf(key, index as u32))
            .unwrap();
        assert!(book.find(TreeKind::Fixed, key).is_ok());
    }
    assert_eq!(book.node_tag(256).unwrap(), 1);
    let best = book.best(TreeKind::Fixed).unwrap().unwrap();
    let best_leaf = book.leaf(best).unwrap();
    assert_eq!(
        unsafe { core::ptr::addr_of!(best_leaf.key).read_unaligned() },
        0
    );
    assert_eq!(
        unsafe { accounts[1].view.borrow_unchecked() }[60..64],
        257u32.to_le_bytes()
    );
    book.remove_owned(TreeKind::Fixed, 128u128 << 64, 128)
        .expect("cross-page leaf can be removed");
    assert!(book.find(TreeKind::Fixed, 128u128 << 64).is_err());
    let reused = book
        .insert(TreeKind::Fixed, leaf(999u128 << 64, 999))
        .expect("free-list slot is reusable");
    assert_eq!(reused, 255);
    book.insert(TreeKind::Fixed, expiring_leaf(2000u128 << 64, 2000, 10))
        .expect("expiry leaf inserts");
    assert!(book.first_expired(TreeKind::Fixed, 9).unwrap().is_none());
    assert!(book.first_expired(TreeKind::Fixed, 10).unwrap().is_some());
    assert_eq!(book.sweep_expired(TreeKind::Fixed, 10, 1).unwrap(), 1);
}

#[test]
fn v3_event_queue_uses_full_records_and_crosses_shard_boundary() {
    let accounts = bundle();
    let mut core = accounts[0].view.clone();
    let mut shards = vec![
        accounts[13].view.clone(),
        accounts[14].view.clone(),
        accounts[15].view.clone(),
        accounts[16].view.clone(),
    ];
    let payload = [9u8; 48];
    for _ in 0..33 {
        append_event_record(&ID, &mut core, &mut shards, 200, &payload, 77).unwrap();
    }
    let first = unsafe { accounts[13].view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(first[44..46].try_into().unwrap()), 200);
    assert_eq!(&first[96..144], &payload);
    let second = unsafe { accounts[14].view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(second[44..46].try_into().unwrap()), 200);
    assert_eq!(u64::from_le_bytes(second[48..56].try_into().unwrap()), 32);
}
