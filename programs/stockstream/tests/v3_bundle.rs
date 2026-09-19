//! Exact V3 execution-bundle account-order and alias validation.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    v3::{
        create_trader_seat, derive_book_page_v3, derive_event_shard_v3, derive_market_core_v3,
        derive_seat_shard_v3, validate_execution_bundle, V3_BOOK_PAGE_SIZE, V3_EVENT_SHARD_SIZE,
        V3_EXECUTION_BUNDLE_LEN, V3_MARKET_CORE_SIZE, V3_SEAT_SHARD_SIZE,
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
    ];
    call.push(trader.view.clone());
    create_trader_seat(&ID, &mut call, 32).expect("seat 32 lives in shard 1 slot 0");
    let occupied = unsafe { accounts[10].view.borrow_unchecked() };
    assert_eq!(occupied[44], 1);
    assert_eq!(&occupied[45..77], trader.view.address().as_ref());
    assert!(create_trader_seat(&ID, &mut call, 1).is_err());
    assert!(create_trader_seat(&ID, &mut call, 128).is_err());
}
