//! Exact V3 execution-bundle account-order and alias validation.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    error::ProgramError,
    Address,
};
use stockstream::{
    book::{LeafNode, Side, TreeKind},
    instruction::{PlaceOrderData, StockStreamInstruction},
    session::{
        self, TradingSession, SESSION_ACTION_PLACE, SESSION_ACTION_REPLACE, TRADING_SESSION_SIZE,
    },
    v3::{
        append_event_record, cancel_all_v3, close_trader_seat, create_trader_seat,
        deposit_collateral_v3, derive_book_page_v3, derive_event_shard_v3, derive_market_core_v3,
        derive_seat_shard_v3, initialize_book_page_metadata, liquidate_v3, place_order_v3,
        update_funding_v3, validate_execution_bundle, validate_v3_session_actor,
        validate_v3_withdrawal_readiness, withdraw_collateral_v3, PagedBookV3,
        V3_BOOK_PAGES_PER_SIDE, V3_BOOK_PAGE_SIZE, V3_EVENT_SHARD_SIZE, V3_EXECUTION_BUNDLE_LEN,
        V3_MARKET_CORE_SIZE, V3_SEAT_SHARD_SIZE,
    },
    ID,
};

const V3_BOOK_ACCOUNT_COUNT: usize = 2 * V3_BOOK_PAGES_PER_SIDE;
const V3_SEAT_START: usize = 1 + V3_BOOK_ACCOUNT_COUNT;
const V3_EVENT_START: usize = V3_SEAT_START + 4;

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
    for flat in 0..V3_BOOK_ACCOUNT_COUNT as u8 {
        let side = flat / V3_BOOK_PAGES_PER_SIDE as u8;
        let page = flat % V3_BOOK_PAGES_PER_SIDE as u8;
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
        price_or_offset: owner as i64 + 1,
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
fn v3_funding_recomputes_mark_from_pages_and_emits_event() {
    let mut accounts = bundle();
    let authority = account(Address::new_from_array([77; 32]), 0, true);
    {
        let core = unsafe { accounts[0].view.borrow_unchecked_mut() };
        core[44..76].copy_from_slice(authority.view.address().as_ref());
        core[180] = 1;
        core[181..189].copy_from_slice(&100i64.to_le_bytes());
        core[189..197].copy_from_slice(&10u64.to_le_bytes());
    }
    let mut page_views = views(&accounts);
    let mut bid_book = PagedBookV3::new(&mut page_views[1..1 + V3_BOOK_PAGES_PER_SIDE]).unwrap();
    let mut bid = leaf(1, 0);
    bid.side = Side::Bid as u8;
    bid.price_or_offset = 95;
    bid_book.insert_resting_order(TreeKind::Fixed, bid).unwrap();
    let mut call = views(&accounts);
    call.push(authority.view.clone());
    update_funding_v3(
        &ID,
        &mut call,
        StockStreamInstruction::UpdateFunding {
            accumulator: 1,
            timestamp: 20,
        },
    )
    .unwrap();
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(core[156..172].try_into().unwrap()), 1);
    assert_eq!(u64::from_le_bytes(core[172..180].try_into().unwrap()), 20);
    let event = unsafe { accounts[V3_EVENT_START].view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(event[44..46].try_into().unwrap()), 302);
}

#[test]
fn v3_funding_uses_configured_mark_deviation_clamp() {
    let mut accounts = bundle();
    let authority = account(Address::new_from_array([78; 32]), 0, true);
    {
        let core = unsafe { accounts[0].view.borrow_unchecked_mut() };
        core[44..76].copy_from_slice(authority.view.address().as_ref());
        core[180] = 1;
        core[181..189].copy_from_slice(&100i64.to_le_bytes());
        core[189..197].copy_from_slice(&10u64.to_le_bytes());
        core[304..306].copy_from_slice(&100u16.to_le_bytes());
        core[371] = 1;
    }
    let mut page_views = views(&accounts);
    let mut bid_book = PagedBookV3::new(&mut page_views[1..1 + V3_BOOK_PAGES_PER_SIDE]).unwrap();
    let mut bid = leaf(1, 0);
    bid.side = Side::Bid as u8;
    bid.price_or_offset = 200;
    bid_book.insert_resting_order(TreeKind::Fixed, bid).unwrap();
    let mut call = views(&accounts);
    call.push(authority.view.clone());
    let result = update_funding_v3(
        &ID,
        &mut call,
        StockStreamInstruction::UpdateFunding {
            accumulator: 200,
            timestamp: 600,
        },
    );
    assert!(result.is_err());
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(core[156..172].try_into().unwrap()), 0);
    assert_eq!(u64::from_le_bytes(core[172..180].try_into().unwrap()), 0);
}

#[test]
fn v3_owner_place_reserves_collateral_and_writes_paged_book_and_event() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([44; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        let bytes = accounts[V3_SEAT_START].view.borrow_unchecked_mut();
        bytes[84..100].copy_from_slice(&1_000_000i128.to_le_bytes());
        accounts[0].view.borrow_unchecked_mut()[197] = 1;
    }
    let mut trade_accounts = views(&accounts);
    trade_accounts.push(owner.view.clone());
    place_order_v3(
        &ID,
        &mut trade_accounts,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::Fixed as u8,
            flags: 0,
            seat_index: 0,
            quantity: 5,
            price_or_offset: 10,
            expires_at: u64::MAX,
            peg_limit: 0,
            client_order_id: 7,
            action_nonce: 0,
        },
    )
    .unwrap();
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    // V3 reserves configured initial margin, not the full notional.
    assert_eq!(i128::from_le_bytes(seat[100..116].try_into().unwrap()), 10);
    assert_eq!(u32::from_le_bytes(seat[212..216].try_into().unwrap()), 1);
    let page = unsafe { accounts[1].view.borrow_unchecked() };
    assert_ne!(
        u32::from_le_bytes(page[44..48].try_into().unwrap()),
        u32::MAX
    );
    let order_key = ((u64::MAX - 10) as u128) << 64 | 1;
    let mut cancel_accounts = views(&accounts);
    cancel_accounts.push(owner.view.clone());
    stockstream::v3::cancel_order_v3(&ID, &mut cancel_accounts, 0, order_key, 0).unwrap();
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(seat[100..116].try_into().unwrap()), 0);
    assert_eq!(u32::from_le_bytes(seat[212..216].try_into().unwrap()), 0);
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[140..148].try_into().unwrap()), 1);
    assert_eq!(u64::from_le_bytes(core[148..156].try_into().unwrap()), 3);
}

#[test]
fn v3_place_rejects_maximum_open_interest_before_mutation() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([45; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        accounts[V3_SEAT_START].view.borrow_unchecked_mut()[84..100]
            .copy_from_slice(&1_000_000i128.to_le_bytes());
        accounts[V3_SEAT_START].view.borrow_unchecked_mut()[116..132]
            .copy_from_slice(&2i128.to_le_bytes());
        let core = accounts[0].view.borrow_unchecked_mut();
        core[197] = 1;
        core[371] = 1;
        core[272..288].copy_from_slice(&1i128.to_le_bytes());
    }
    let before_page = unsafe { accounts[1].view.borrow_unchecked().to_vec() };
    let mut trade_accounts = views(&accounts);
    trade_accounts.push(owner.view.clone());
    let result = place_order_v3(
        &ID,
        &mut trade_accounts,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::Fixed as u8,
            flags: 0,
            seat_index: 0,
            quantity: 5,
            price_or_offset: 10,
            expires_at: u64::MAX,
            peg_limit: 0,
            client_order_id: 8,
            action_nonce: 0,
        },
    );
    assert!(result.is_err());
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(u32::from_le_bytes(seat[212..216].try_into().unwrap()), 0);
    assert_eq!(unsafe { accounts[1].view.borrow_unchecked() }, before_page);
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[140..148].try_into().unwrap()), 0);
}

#[test]
fn v3_reduce_only_rejects_an_oversized_direction_flip_before_mutation() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([49; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        let seat = accounts[V3_SEAT_START].view.borrow_unchecked_mut();
        seat[84..100].copy_from_slice(&1_000_000i128.to_le_bytes());
        seat[116..132].copy_from_slice(&10i128.to_le_bytes());
        accounts[0].view.borrow_unchecked_mut()[197] = 1;
    }
    let before_page = unsafe { accounts[1].view.borrow_unchecked().to_vec() };
    let mut trade_accounts = views(&accounts);
    trade_accounts.push(owner.view.clone());
    let result = place_order_v3(
        &ID,
        &mut trade_accounts,
        PlaceOrderData {
            side: Side::Ask as u8,
            tree: TreeKind::Fixed as u8,
            flags: 4,
            seat_index: 0,
            quantity: 15,
            price_or_offset: 10,
            expires_at: u64::MAX,
            peg_limit: 0,
            client_order_id: 9,
            action_nonce: 0,
        },
    );
    assert!(result.is_err());
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(seat[116..132].try_into().unwrap()), 10);
    assert_eq!(unsafe { accounts[1].view.borrow_unchecked() }, before_page);
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[140..148].try_into().unwrap()), 0);
}

#[test]
fn v3_place_rejects_an_invalid_oracle_peg_before_mutation() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([50; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        accounts[V3_SEAT_START].view.borrow_unchecked_mut()[84..100]
            .copy_from_slice(&1_000_000i128.to_le_bytes());
        let core = accounts[0].view.borrow_unchecked_mut();
        core[180] = 1;
        core[181..189].copy_from_slice(&100i64.to_le_bytes());
        core[189..197].copy_from_slice(&10u64.to_le_bytes());
        core[197] = 1;
    }
    let before_page = unsafe { accounts[1].view.borrow_unchecked().to_vec() };
    let mut trade_accounts = views(&accounts);
    trade_accounts.push(owner.view.clone());
    let result = place_order_v3(
        &ID,
        &mut trade_accounts,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::OraclePegged as u8,
            flags: 0,
            seat_index: 0,
            quantity: 5,
            price_or_offset: 5,
            expires_at: u64::MAX,
            peg_limit: 100,
            client_order_id: 10,
            action_nonce: 0,
        },
    );
    assert!(result.is_err());
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(u32::from_le_bytes(seat[212..216].try_into().unwrap()), 0);
    assert_eq!(unsafe { accounts[1].view.borrow_unchecked() }, before_page);
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[140..148].try_into().unwrap()), 0);
}

#[test]
fn v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([47; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        accounts[V3_SEAT_START].view.borrow_unchecked_mut()[84..100]
            .copy_from_slice(&1_000_000i128.to_le_bytes());
        let core = accounts[0].view.borrow_unchecked_mut();
        core[180] = 1;
        core[181..189].copy_from_slice(&100i64.to_le_bytes());
        core[197] = 1;
    }
    for (tree, price_or_offset, quantity) in [
        (TreeKind::Fixed, 10i64, 5u64),
        (TreeKind::OraclePegged, -89i64, 3u64),
    ] {
        let mut trade_accounts = views(&accounts);
        trade_accounts.push(owner.view.clone());
        place_order_v3(
            &ID,
            &mut trade_accounts,
            PlaceOrderData {
                side: Side::Bid as u8,
                tree: tree as u8,
                flags: 0,
                seat_index: 0,
                quantity,
                price_or_offset,
                expires_at: u64::MAX,
                peg_limit: if tree == TreeKind::OraclePegged {
                    100
                } else {
                    0
                },
                client_order_id: quantity,
                action_nonce: 0,
            },
        )
        .unwrap();
    }
    // Existing pegged orders remain cancellable when the current oracle is
    // stale/temporarily invalid; the last stored price is used only to release
    // their reservation, never to admit a new pegged order.
    unsafe { accounts[0].view.borrow_unchecked_mut()[180] = 0 };
    let mut cancel_accounts = views(&accounts);
    cancel_accounts.push(owner.view.clone());
    cancel_all_v3(&ID, &mut cancel_accounts, 0, 10, 0).unwrap();
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(seat[100..116].try_into().unwrap()), 0);
    assert_eq!(i128::from_le_bytes(seat[180..196].try_into().unwrap()), 0);
    assert_eq!(u32::from_le_bytes(seat[212..216].try_into().unwrap()), 0);
}

#[test]
fn v3_liquidation_updates_open_interest_and_insurance_fee() {
    let mut accounts = bundle();
    let authority = account(Address::new_from_array([48; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        authority.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        let core = accounts[0].view.borrow_unchecked_mut();
        core[44..76].copy_from_slice(authority.view.address().as_ref());
        core[180] = 1;
        core[181..189].copy_from_slice(&100i64.to_le_bytes());
        core[156..172].copy_from_slice(&100_000i128.to_le_bytes());
        core[197] = 1;
        core[288..304].copy_from_slice(&10i128.to_le_bytes());
        let seat = accounts[V3_SEAT_START].view.borrow_unchecked_mut();
        seat[84..100].copy_from_slice(&1i128.to_le_bytes());
        seat[116..132].copy_from_slice(&10i128.to_le_bytes());
        seat[132..148].copy_from_slice(&1_000i128.to_le_bytes());
    }
    let mut liquidation_accounts = views(&accounts);
    liquidation_accounts.push(authority.view.clone());
    liquidate_v3(&ID, &mut liquidation_accounts, 0, 5).unwrap();
    let seat = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(seat[116..132].try_into().unwrap()), 5);
    assert_eq!(i128::from_le_bytes(seat[148..164].try_into().unwrap()), -3);
    assert_eq!(
        i128::from_le_bytes(seat[164..180].try_into().unwrap()),
        100_000
    );
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(i128::from_le_bytes(core[288..304].try_into().unwrap()), 5);
    assert_eq!(i128::from_le_bytes(core[322..338].try_into().unwrap()), 2);
    assert_eq!(i128::from_le_bytes(core[338..354].try_into().unwrap()), 2);
}

#[test]
fn v3_fixed_cross_updates_both_seats_and_consumes_resting_leaf() {
    let mut accounts = bundle();
    let owner_a = account(Address::new_from_array([45; 32]), 0, true);
    let owner_b = account(Address::new_from_array([46; 32]), 0, true);
    for (seat_index, owner) in [(0u16, &owner_a), (1u16, &owner_b)] {
        let mut call = vec![
            accounts[0].view.clone(),
            accounts[V3_SEAT_START].view.clone(),
            accounts[V3_SEAT_START + 1].view.clone(),
            accounts[V3_SEAT_START + 2].view.clone(),
            accounts[V3_SEAT_START + 3].view.clone(),
            accounts[V3_EVENT_START].view.clone(),
            accounts[V3_EVENT_START + 1].view.clone(),
            accounts[V3_EVENT_START + 2].view.clone(),
            accounts[V3_EVENT_START + 3].view.clone(),
            owner.view.clone(),
        ];
        create_trader_seat(&ID, &mut call, seat_index).unwrap();
    }
    unsafe {
        let bytes = accounts[V3_SEAT_START].view.borrow_unchecked_mut();
        bytes[84..100].copy_from_slice(&1_000_000i128.to_le_bytes());
        let second = 44 + 256;
        bytes[second + 40..second + 56].copy_from_slice(&1_000_000i128.to_le_bytes());
        accounts[0].view.borrow_unchecked_mut()[197] = 1;
    }
    let mut ask = views(&accounts);
    ask.push(owner_a.view.clone());
    place_order_v3(
        &ID,
        &mut ask,
        PlaceOrderData {
            side: Side::Ask as u8,
            tree: TreeKind::Fixed as u8,
            flags: 0,
            seat_index: 0,
            quantity: 3,
            price_or_offset: 10,
            expires_at: u64::MAX,
            peg_limit: 0,
            client_order_id: 1,
            action_nonce: 0,
        },
    )
    .unwrap();
    let mut bid = views(&accounts);
    bid.push(owner_b.view.clone());
    place_order_v3(
        &ID,
        &mut bid,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::Fixed as u8,
            flags: 2,
            seat_index: 1,
            quantity: 3,
            price_or_offset: 10,
            expires_at: u64::MAX,
            peg_limit: 0,
            client_order_id: 2,
            action_nonce: 0,
        },
    )
    .unwrap();
    let seats = unsafe { accounts[V3_SEAT_START].view.borrow_unchecked() };
    let first_base = i128::from_le_bytes(seats[44 + 72..44 + 88].try_into().unwrap());
    let second_base = i128::from_le_bytes(seats[44 + 256 + 72..44 + 256 + 88].try_into().unwrap());
    assert_eq!(first_base, -3);
    assert_eq!(second_base, 3);
    assert_eq!(
        u32::from_le_bytes(seats[44 + 168..44 + 172].try_into().unwrap()),
        0
    );
}

#[test]
fn v3_bundle_rejects_duplicate_substitution_and_foreign_parent() {
    let mut accounts = bundle();
    let mut duplicate = views(&accounts);
    duplicate[2] = duplicate[1].clone();
    assert!(validate_execution_bundle(&ID, &duplicate, true).is_err());
    unsafe {
        accounts[V3_SEAT_START].view.borrow_unchecked_mut()[12] ^= 1;
    }
    assert!(validate_execution_bundle(&ID, &views(&accounts), true).is_err());
}

#[test]
fn v3_session_actor_binds_sharded_seat_and_rejects_replay_or_risk() {
    let accounts = bundle();
    let owner = account(Address::new_from_array([42; 32]), 0, true);
    let session_signer = account(Address::new_from_array([43; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 32).unwrap();
    let core_key = *accounts[0].view.address();
    let session_key = session::derive_trading_session(
        &owner.view.address(),
        &core_key,
        32,
        &session_signer.view.address(),
        &ID,
    );
    let mut session_account = account(session_key, TRADING_SESSION_SIZE, false);
    let mut state = TradingSession::empty();
    state.initialized = 1;
    state.owner = owner.view.address().to_bytes();
    state.session_signer = session_signer.view.address().to_bytes();
    state.target_program = ID.to_bytes();
    state.market = core_key.to_bytes();
    state.trader_seat_index = 32;
    state.expires_at = 100;
    state.actions = SESSION_ACTION_PLACE;
    state.max_order_notional = 10;
    state.max_cumulative_notional = 20;
    state.max_exposure = 10;
    state.max_open_orders = 2;
    {
        let mut session_bytes = unsafe { session_account.view.borrow_unchecked_mut() };
        session::write_session(&mut session_bytes, &state).unwrap();
    }
    let shards = [
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
    ];
    let authorized = validate_v3_session_actor(
        &ID,
        &accounts[0].view,
        &shards,
        &session_account.view,
        &session_signer.view,
        32,
        SESSION_ACTION_PLACE,
        5,
        5,
        1,
        1,
        1,
    )
    .unwrap();
    let next_nonce = authorized.session.next_expected_nonce;
    assert_eq!(next_nonce, 1);
    assert_eq!(authorized.seat.trader, owner.view.address().to_bytes());
    assert!(validate_v3_session_actor(
        &ID,
        &accounts[0].view,
        &shards,
        &session_account.view,
        &session_signer.view,
        32,
        SESSION_ACTION_PLACE,
        5,
        5,
        1,
        2,
        1,
    )
    .is_err());
    assert!(validate_v3_session_actor(
        &ID,
        &accounts[0].view,
        &shards,
        &session_account.view,
        &session_signer.view,
        32,
        SESSION_ACTION_PLACE,
        21,
        5,
        1,
        1,
        1,
    )
    .is_err());
    assert!(validate_v3_session_actor(
        &ID,
        &accounts[0].view,
        &shards,
        &session_account.view,
        &session_signer.view,
        32,
        SESSION_ACTION_PLACE,
        5,
        5,
        3,
        2,
        1,
    )
    .is_err());
}

#[test]
fn v3_session_replace_consumes_one_nonce_and_requires_replace_permission() {
    let mut accounts = bundle();
    let owner = account(Address::new_from_array([52; 32]), 0, true);
    let session_signer = account(Address::new_from_array([53; 32]), 0, true);
    let mut seat_call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
        owner.view.clone(),
    ];
    create_trader_seat(&ID, &mut seat_call, 0).unwrap();
    unsafe {
        let bytes = accounts[V3_SEAT_START].view.borrow_unchecked_mut();
        bytes[44 + 40..44 + 56].copy_from_slice(&1_000i128.to_le_bytes());
        accounts[0].view.borrow_unchecked_mut()[197] = 1;
    }
    let core_key = *accounts[0].view.address();
    let session_key = session::derive_trading_session(
        &owner.view.address(),
        &core_key,
        0,
        &session_signer.view.address(),
        &ID,
    );
    let mut session_account = account(session_key, TRADING_SESSION_SIZE, false);
    let mut state = TradingSession::empty();
    state.initialized = 1;
    state.owner = owner.view.address().to_bytes();
    state.session_signer = session_signer.view.address().to_bytes();
    state.target_program = ID.to_bytes();
    state.market = core_key.to_bytes();
    state.trader_seat_index = 0;
    state.expires_at = 100;
    state.actions = SESSION_ACTION_PLACE | SESSION_ACTION_REPLACE;
    state.max_order_notional = 100;
    state.max_cumulative_notional = 500;
    state.max_exposure = 100;
    state.max_open_orders = 2;
    session::write_session(
        &mut unsafe { session_account.view.borrow_unchecked_mut() },
        &state,
    )
    .unwrap();
    let mut first = views(&accounts);
    first.push(session_signer.view.clone());
    first.push(session_account.view.clone());
    place_order_v3(
        &ID,
        &mut first,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::Fixed as u8,
            flags: 0,
            seat_index: 0,
            quantity: 1,
            price_or_offset: 5,
            expires_at: 100,
            peg_limit: 0,
            client_order_id: 1,
            action_nonce: 1,
        },
    )
    .unwrap();
    let old_key = ((u64::MAX - 5) as u128) << 64 | 1;
    let mut replacement = views(&accounts);
    replacement.push(session_signer.view.clone());
    replacement.push(session_account.view.clone());
    stockstream::v3::replace_order_v3(
        &ID,
        &mut replacement,
        old_key,
        PlaceOrderData {
            side: Side::Bid as u8,
            tree: TreeKind::Fixed as u8,
            flags: 0,
            seat_index: 0,
            quantity: 1,
            price_or_offset: 6,
            expires_at: 100,
            peg_limit: 0,
            client_order_id: 2,
            action_nonce: 2,
        },
    )
    .unwrap();
    let session =
        session::read_session(unsafe { session_account.view.borrow_unchecked() }).unwrap();
    let next_nonce = session.next_expected_nonce;
    let consumed = session.consumed_cumulative_notional;
    assert_eq!(next_nonce, 3);
    assert_eq!(consumed, 11);
}

#[test]
fn v3_seat_creation_uses_derived_shard_and_prevents_cross_shard_duplicates() {
    let accounts = bundle();
    let trader = account(Address::new_from_array([42; 32]), 0, true);
    let mut call = vec![
        accounts[0].view.clone(),
        accounts[V3_SEAT_START].view.clone(),
        accounts[V3_SEAT_START + 1].view.clone(),
        accounts[V3_SEAT_START + 2].view.clone(),
        accounts[V3_SEAT_START + 3].view.clone(),
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
    ];
    call.push(trader.view.clone());
    create_trader_seat(&ID, &mut call, 32).expect("seat 32 lives in shard 1 slot 0");
    let occupied = unsafe { accounts[V3_SEAT_START + 1].view.borrow_unchecked() };
    assert_eq!(occupied[44], 1);
    assert_eq!(&occupied[45..77], trader.view.address().as_ref());
    assert!(create_trader_seat(&ID, &mut call, 1).is_err());
    assert!(create_trader_seat(&ID, &mut call, 128).is_err());
    close_trader_seat(&ID, &mut call, 32).expect("empty seat closes");
    assert_eq!(
        unsafe { accounts[V3_SEAT_START + 1].view.borrow_unchecked() }[44],
        0
    );
    assert!(close_trader_seat(&ID, &mut call, 32).is_err());
    create_trader_seat(&ID, &mut call, 32).expect("closed seat can be reused");
    let core = unsafe { accounts[0].view.borrow_unchecked() };
    assert_eq!(u64::from_le_bytes(core[148..156].try_into().unwrap()), 3);
}

#[test]
fn v3_paged_book_preserves_global_handles_across_page_boundaries() {
    let accounts = bundle();
    let mut pages = (1..=V3_BOOK_PAGES_PER_SIDE)
        .map(|index| accounts[index].view.clone())
        .collect::<Vec<_>>();
    let mut book = PagedBookV3::new(&mut pages).unwrap();
    for index in 0..129u128 {
        let key = index << 64;
        book.insert(TreeKind::Fixed, leaf(key, index as u32))
            .unwrap();
        assert!(book.find(TreeKind::Fixed, key).is_ok());
    }
    assert_eq!(book.node_tag(256).unwrap(), 1);
    let plan = book
        .plan_crossing(
            TreeKind::Fixed,
            Side::Bid,
            2_000,
            stockstream::book::SelfTradeBehavior::AbortTransaction,
            2_000,
            1,
            None,
            0,
        )
        .unwrap();
    assert_eq!(plan.fill_count, 1);
    assert_eq!(plan.fills[0].maker_handle, 0);
    book.apply_match_plan(TreeKind::Fixed, &plan).unwrap();
    assert!(book.apply_match_plan(TreeKind::Fixed, &plan).is_err());
    assert!(book.find(TreeKind::Fixed, 0).is_err());
    let best = book.best(TreeKind::Fixed).unwrap().unwrap();
    let best_leaf = book.leaf(best).unwrap();
    assert_eq!(
        unsafe { core::ptr::addr_of!(best_leaf.key).read_unaligned() },
        1u128 << 64
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
    let pegged = book
        .insert(TreeKind::OraclePegged, leaf(7u128 << 64, 7))
        .expect("oracle-pegged root uses the same paged storage");
    assert!(book.find(TreeKind::OraclePegged, 7u128 << 64).is_ok());
    assert_eq!(book.node_tag(pegged).unwrap(), 2);
}

#[test]
fn v3_cross_tree_matching_uses_executable_price_then_fifo_key() {
    let accounts = bundle();
    let mut pages = (1..=V3_BOOK_PAGES_PER_SIDE)
        .map(|index| accounts[index].view.clone())
        .collect::<Vec<_>>();
    let mut book = PagedBookV3::new(&mut pages).unwrap();
    let mut fixed = leaf(11u128 << 64, 11);
    fixed.price_or_offset = 11;
    book.insert(TreeKind::Fixed, fixed).unwrap();
    let mut pegged = leaf(12u128 << 64, 12);
    pegged.price_or_offset = 2;
    pegged.peg_limit = 12;
    book.insert(TreeKind::OraclePegged, pegged).unwrap();
    let plan = book
        .plan_crossing_cross_tree(
            Side::Bid,
            99,
            stockstream::book::SelfTradeBehavior::AbortTransaction,
            20,
            2,
            Some(10),
            0,
        )
        .unwrap();
    assert_eq!(plan.fill_count, 2);
    assert_eq!(plan.fills[0].maker_tree, TreeKind::Fixed as u8);
    assert_eq!(plan.fills[0].price, 11);
    assert_eq!(plan.fills[1].maker_tree, TreeKind::OraclePegged as u8);
    assert_eq!(plan.fills[1].price, 12);
    book.apply_match_plan(TreeKind::Fixed, &plan).unwrap();
    assert!(book.find(TreeKind::Fixed, fixed.key).is_err());
    assert!(book.find(TreeKind::OraclePegged, pegged.key).is_err());
}

#[test]
fn v3_self_trade_policies_apply_on_paged_books() {
    let accounts = bundle();
    let mut pages = (1..=V3_BOOK_PAGES_PER_SIDE)
        .map(|index| accounts[index].view.clone())
        .collect::<Vec<_>>();
    let mut book = PagedBookV3::new(&mut pages).unwrap();
    let resting = leaf(7u128 << 64, 7);
    book.insert(TreeKind::Fixed, resting).unwrap();
    assert_eq!(
        book.plan_crossing(
            TreeKind::Fixed,
            Side::Bid,
            7,
            stockstream::book::SelfTradeBehavior::AbortTransaction,
            20,
            1,
            None,
            0,
        )
        .unwrap_err(),
        stockstream::error::StockStreamError::SelfTradeAborted.into()
    );
    let decrement = book
        .plan_crossing(
            TreeKind::Fixed,
            Side::Bid,
            7,
            stockstream::book::SelfTradeBehavior::DecrementTake,
            20,
            1,
            None,
            0,
        )
        .unwrap();
    assert_eq!(decrement.fill_count, 0);
    assert_eq!(decrement.taker_remaining, 0);
    let cancel = book
        .plan_crossing(
            TreeKind::Fixed,
            Side::Bid,
            7,
            stockstream::book::SelfTradeBehavior::CancelProvide,
            20,
            1,
            None,
            0,
        )
        .unwrap();
    assert_eq!(cancel.cancellation_count, 1);
    book.apply_match_plan(TreeKind::Fixed, &cancel).unwrap();
    assert!(book.find(TreeKind::Fixed, 7u128 << 64).is_err());
}

#[test]
fn v3_event_queue_uses_full_records_and_crosses_shard_boundary() {
    let accounts = bundle();
    let mut core = accounts[0].view.clone();
    let mut shards = vec![
        accounts[V3_EVENT_START].view.clone(),
        accounts[V3_EVENT_START + 1].view.clone(),
        accounts[V3_EVENT_START + 2].view.clone(),
        accounts[V3_EVENT_START + 3].view.clone(),
    ];
    let payload = [9u8; 48];
    for _ in 0..33 {
        append_event_record(&ID, &mut core, &mut shards, 200, &payload, 77).unwrap();
    }
    let first = unsafe { accounts[V3_EVENT_START].view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(first[44..46].try_into().unwrap()), 200);
    assert_eq!(&first[96..144], &payload);
    let second = unsafe { accounts[V3_EVENT_START + 1].view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(second[44..46].try_into().unwrap()), 200);
    assert_eq!(u64::from_le_bytes(second[48..56].try_into().unwrap()), 32);
}

#[test]
fn v3_withdrawal_requires_restored_and_reconciled_full_bundle() {
    let mut accounts = bundle();
    unsafe {
        let core = accounts[0].view.borrow_unchecked_mut();
        core[197] = 3;
        core[198..206].copy_from_slice(&7u64.to_le_bytes());
        core[206..214].copy_from_slice(&7u64.to_le_bytes());
    }
    assert!(validate_v3_withdrawal_readiness(&ID, &views(&accounts)).is_ok());
    unsafe {
        accounts[0].view.borrow_unchecked_mut()[206] = 6;
    }
    assert!(validate_v3_withdrawal_readiness(&ID, &views(&accounts)).is_err());
}

#[test]
fn v3_custody_requires_explicit_account_shapes() {
    let mut empty: Vec<AccountView> = Vec::new();
    assert_eq!(
        deposit_collateral_v3(&ID, &mut empty, 0, 1),
        Err(ProgramError::NotEnoughAccountKeys)
    );
    assert_eq!(
        withdraw_collateral_v3(&ID, &mut empty, 0, 1),
        Err(ProgramError::NotEnoughAccountKeys)
    );
}
