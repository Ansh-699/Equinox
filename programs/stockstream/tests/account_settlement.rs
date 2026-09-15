use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    book::{plan_limit_arenas_into, Arena, MatchLimits, OrderInput, Side, TimeInForce, TreeKind},
    handlers::validate_planned_settlement_for_test,
    process_instruction,
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchView, SETTLEMENT_SCRATCH_LEN,
    },
    state::{
        MarketMode, MarketStateHeader, TraderSeat, MARKET_ACCOUNT_SIZE, MARKET_HEADER_SIZE,
        TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE,
    },
    ID,
};

struct TestAccount {
    _storage: Vec<u64>,
    view: AccountView,
}

fn account(
    address: Address,
    owner: Address,
    data_len: usize,
    signer: bool,
    writable: bool,
) -> TestAccount {
    let words = (size_of::<RuntimeAccount>() + data_len).div_ceil(size_of::<u64>());
    let mut storage = vec![0u64; words];
    let raw = storage.as_mut_ptr() as *mut RuntimeAccount;
    unsafe {
        ptr::write(
            raw,
            RuntimeAccount {
                borrow_state: NOT_BORROWED,
                is_signer: signer as u8,
                is_writable: writable as u8,
                executable: 0,
                padding: [0; 4],
                address,
                owner,
                lamports: 1,
                data_len: data_len as u64,
            },
        );
    }
    let view = unsafe { AccountView::new_unchecked(raw) };
    TestAccount {
        _storage: storage,
        view,
    }
}

fn set_open_oracle(market: &mut TestAccount, authority: Address) {
    let data = unsafe { market.view.borrow_unchecked_mut() };
    let header = unsafe { &mut *(data.as_mut_ptr() as *mut MarketStateHeader) };
    header.mode = MarketMode::Open as u8;
    header.oracle_valid = 1;
    header.last_verified_oracle_price = 100;
    header.last_verified_oracle_timestamp = 1;
    header.maximum_position = 1_000_000;
    header.maximum_open_interest = 1_000_000;
    header.market_authority = authority.to_bytes();
    header.pause_authority = authority.to_bytes();
    header.emergency_authority = authority.to_bytes();
}

fn credit(market: &mut TestAccount, index: usize, amount: i128) {
    let data = unsafe { market.view.borrow_unchecked_mut() };
    let start = TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE;
    let seat = unsafe { &mut *(data.as_mut_ptr().add(start) as *mut TraderSeat) };
    seat.available_collateral = amount;
}

fn order_data(side: u8, seat: u16, quantity: u64, price: i64, flags: u8, client: u64) -> Vec<u8> {
    let mut data = vec![3, side, 0, flags, 0, 0];
    data[4..6].copy_from_slice(&seat.to_le_bytes());
    data.extend_from_slice(&quantity.to_le_bytes());
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes());
    data.extend_from_slice(&client.to_le_bytes());
    data
}

struct Fixture {
    market: TestAccount,
    maker: TestAccount,
    taker: TestAccount,
    maker_scratch: TestAccount,
    taker_scratch: TestAccount,
}

fn fixture() -> Fixture {
    let maker_address = Address::new_from_array([61; 32]);
    let taker_address = Address::new_from_array([62; 32]);
    let mut market = account(
        Address::new_from_array([63; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let maker = account(maker_address.clone(), ID, 0, true, false);
    let taker = account(taker_address, ID, 0, true, false);
    {
        let mut a = [market.view.clone(), maker.view.clone()];
        process_instruction(&ID, &mut a, &[0]).unwrap();
    }
    set_open_oracle(&mut market, maker_address);
    {
        let mut a = [market.view.clone(), maker.view.clone()];
        process_instruction(&ID, &mut a, &[1, 0, 0]).unwrap();
    }
    {
        let mut a = [market.view.clone(), taker.view.clone()];
        process_instruction(&ID, &mut a, &[1, 1, 0]).unwrap();
    }
    credit(&mut market, 0, 1_000_000);
    credit(&mut market, 1, 1_000_000);
    let maker_scratch = account(
        derive_settlement_scratch(market.view.address(), 0, &ID),
        ID,
        SETTLEMENT_SCRATCH_LEN,
        false,
        true,
    );
    let taker_scratch = account(
        derive_settlement_scratch(market.view.address(), 1, &ID),
        ID,
        SETTLEMENT_SCRATCH_LEN,
        false,
        true,
    );
    {
        let mut a = [
            market.view.clone(),
            maker.view.clone(),
            maker_scratch.view.clone(),
        ];
        process_instruction(&ID, &mut a, &[8, 0, 0]).unwrap();
    }
    {
        let mut a = [
            market.view.clone(),
            taker.view.clone(),
            taker_scratch.view.clone(),
        ];
        process_instruction(&ID, &mut a, &[8, 1, 0]).unwrap();
    }
    Fixture {
        market,
        maker,
        taker,
        maker_scratch,
        taker_scratch,
    }
}

fn place(f: &Fixture, maker: bool, data: &[u8]) -> Result<(), pinocchio::error::ProgramError> {
    let mut accounts = if maker {
        [
            f.market.view.clone(),
            f.maker.view.clone(),
            f.maker_scratch.view.clone(),
        ]
    } else {
        [
            f.market.view.clone(),
            f.taker.view.clone(),
            f.taker_scratch.view.clone(),
        ]
    };
    process_instruction(&ID, &mut accounts, data)
}

fn prepare_crossing_plan(f: &mut Fixture) -> (OrderInput, MarketStateHeader, TraderSeat) {
    place(f, true, &order_data(1, 0, 10, 100, 0, 701)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let header = unsafe { ptr::read_unaligned(data.as_ptr() as *const MarketStateHeader) };
    let taker = unsafe {
        ptr::read_unaligned(
            data.as_ptr().add(TRADER_SEAT_OFFSET + TRADER_SEAT_SIZE) as *const TraderSeat
        )
    };
    let input = OrderInput {
        side: Side::Bid,
        tree: TreeKind::Fixed,
        owner: 1,
        price_or_offset: 110,
        sequence: header.global_order_sequence + 1,
        quantity: 4,
        expires_at: 0,
        peg_limit: 0,
        client_order_id: 702,
        time_in_force: TimeInForce::GoodTilCancelled,
        post_only: false,
    };
    let scratch_data = unsafe { f.taker_scratch.view.borrow_unchecked_mut() };
    let mut scratch = SettlementScratchView::new(scratch_data).unwrap();
    scratch
        .begin(f.market.view.address().to_bytes(), taker.trader, 1)
        .unwrap();
    {
        let plan = scratch.plan_mut();
        let bids =
            unsafe { &*(data.as_ptr().add(stockstream::state::BID_ARENA_OFFSET) as *const Arena) };
        let asks =
            unsafe { &*(data.as_ptr().add(stockstream::state::ASK_ARENA_OFFSET) as *const Arena) };
        plan_limit_arenas_into(
            bids,
            asks,
            input,
            Some(header.last_verified_oracle_price),
            header.last_verified_oracle_timestamp,
            MatchLimits {
                max_fills: stockstream::book::MAX_FILLS_PER_INSTRUCTION as u8,
                max_invalid_removals: 4,
                max_expired_removals: 2,
            },
            plan,
        )
        .unwrap();
        plan.expected_oracle_price = header.last_verified_oracle_price;
        plan.expected_oracle_timestamp = header.last_verified_oracle_timestamp;
        plan.expected_funding_accumulator = header.funding_accumulator;
        plan.expected_event_sequence = header.global_event_sequence;
        plan.expected_order_sequence = input.sequence;
    }
    let plan = scratch.plan();
    let mut scratch_header = scratch.read_header();
    scratch_header.status = ScratchStatus::Ready as u8;
    scratch_header.expected_order_sequence = header.global_order_sequence;
    scratch_header.expected_event_sequence = header.global_event_sequence;
    scratch_header.expected_oracle_timestamp = header.last_verified_oracle_timestamp;
    scratch_header.expected_funding_timestamp = header.last_funding_timestamp;
    scratch_header.fill_count = plan.fill_count;
    scratch_header.event_count = plan.fill_count;
    scratch.write_header(&scratch_header);
    (input, header, taker)
}

#[test]
fn serialized_market_can_create_seats_and_settle_crossing_orders() {
    let authority = Address::new_from_array([7; 32]);
    let trader_b = Address::new_from_array([8; 32]);
    let mut market = account(
        Address::new_from_array([9; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let signer_a = account(authority.clone(), ID, 0, true, false);
    let signer_b = account(trader_b, ID, 0, true, false);
    let scratch_a = account(
        derive_settlement_scratch(market.view.address(), 0, &ID),
        ID,
        SETTLEMENT_SCRATCH_LEN,
        false,
        true,
    );
    let mut scratch_b = account(
        derive_settlement_scratch(market.view.address(), 1, &ID),
        ID,
        SETTLEMENT_SCRATCH_LEN,
        false,
        true,
    );

    {
        let mut accounts = [market.view.clone(), signer_a.view.clone()];
        process_instruction(&ID, &mut accounts, &[0]).unwrap();
    }
    set_open_oracle(&mut market, authority);
    {
        let mut accounts = [market.view.clone(), signer_a.view.clone()];
        process_instruction(&ID, &mut accounts, &[1, 0, 0]).unwrap();
    }
    {
        let mut accounts = [market.view.clone(), signer_b.view.clone()];
        process_instruction(&ID, &mut accounts, &[1, 1, 0]).unwrap();
    }
    credit(&mut market, 0, 1_000_000);
    credit(&mut market, 1, 1_000_000);
    {
        let mut accounts = [
            market.view.clone(),
            signer_a.view.clone(),
            scratch_a.view.clone(),
        ];
        process_instruction(&ID, &mut accounts, &[8, 0, 0]).unwrap();
    }
    {
        let mut accounts = [
            market.view.clone(),
            signer_b.view.clone(),
            scratch_b.view.clone(),
        ];
        process_instruction(&ID, &mut accounts, &[8, 1, 0]).unwrap();
    }
    let mut maker_order = vec![3, 1, 0, 0, 0, 0];
    maker_order.extend_from_slice(&10u64.to_le_bytes());
    maker_order.extend_from_slice(&100i64.to_le_bytes());
    maker_order.extend_from_slice(&0u64.to_le_bytes());
    maker_order.extend_from_slice(&0i64.to_le_bytes());
    maker_order.extend_from_slice(&11u64.to_le_bytes());
    {
        let mut accounts = [
            market.view.clone(),
            signer_a.view.clone(),
            scratch_a.view.clone(),
        ];
        process_instruction(&ID, &mut accounts, &maker_order).unwrap();
    }

    let mut taker_order = maker_order.clone();
    taker_order[1] = 0;
    taker_order[4] = 1;
    taker_order[14..22].copy_from_slice(&110i64.to_le_bytes());
    taker_order[38..46].copy_from_slice(&12u64.to_le_bytes());
    {
        let mut accounts = [
            market.view.clone(),
            signer_b.view.clone(),
            scratch_b.view.clone(),
        ];
        process_instruction(&ID, &mut accounts, &taker_order).unwrap();
    }

    let data = unsafe { market.view.borrow_unchecked() };
    let maker = unsafe { &*(data.as_ptr().add(TRADER_SEAT_OFFSET) as *const TraderSeat) };
    let taker = unsafe {
        &*(data.as_ptr().add(TRADER_SEAT_OFFSET + TRADER_SEAT_SIZE) as *const TraderSeat)
    };
    let maker_position = maker.base_position;
    let taker_position = taker.base_position;
    assert_eq!(maker_position, -10);
    assert_eq!(taker_position, 10);
    assert_eq!(data[MARKET_HEADER_SIZE + 1], 0);
    let header = unsafe { &*(data.as_ptr() as *const MarketStateHeader) };
    let open_interest = header.current_open_interest;
    let event_sequence = header.global_event_sequence;
    assert_eq!(open_interest, 10);
    assert_eq!(event_sequence, 1);
    let event_offset = stockstream::state::FILL_EVENT_OFFSET;
    let event =
        unsafe { &*(data.as_ptr().add(event_offset) as *const stockstream::state::FillEvent) };
    let event_price = event.price;
    let event_quantity = event.quantity;
    assert_eq!(event_price, 100);
    assert_eq!(event_quantity, 10);
    let scratch_data = unsafe { scratch_b.view.borrow_unchecked_mut() };
    let scratch = SettlementScratchView::new(scratch_data).unwrap();
    assert_eq!(scratch.read_header().status, ScratchStatus::Empty as u8);
}

#[test]
fn failed_wrong_owner_cancel_does_not_change_serialized_account() {
    let authority = Address::new_from_array([17; 32]);
    let attacker = Address::new_from_array([18; 32]);
    let market = account(
        Address::new_from_array([19; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let signer = account(authority, ID, 0, true, false);
    let attacker_account = account(attacker, ID, 0, true, false);
    let before = unsafe { market.view.borrow_unchecked() }.to_vec();
    let mut accounts = [market.view.clone(), attacker_account.view.clone()];
    let result = process_instruction(
        &ID,
        &mut accounts,
        &[4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    assert!(result.is_err());
    assert_eq!(before, unsafe { market.view.borrow_unchecked() });
    let _ = signer;
}

#[test]
fn settlement_scratch_rejects_a_non_pda_without_mutating_any_account() {
    let trader = Address::new_from_array([41; 32]);
    let market = account(
        Address::new_from_array([42; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let signer = account(trader, ID, 0, true, false);
    let scratch = account(
        Address::new_from_array([43; 32]),
        ID,
        SETTLEMENT_SCRATCH_LEN,
        false,
        true,
    );
    {
        let mut accounts = [market.view.clone(), signer.view.clone()];
        process_instruction(&ID, &mut accounts, &[0]).unwrap();
    }
    {
        let mut accounts = [market.view.clone(), signer.view.clone()];
        process_instruction(&ID, &mut accounts, &[1, 0, 0]).unwrap();
    }
    let market_before = unsafe { market.view.borrow_unchecked() }.to_vec();
    let scratch_before = unsafe { scratch.view.borrow_unchecked() }.to_vec();
    let mut accounts = [
        market.view.clone(),
        signer.view.clone(),
        scratch.view.clone(),
    ];
    assert!(process_instruction(&ID, &mut accounts, &[8, 0, 0]).is_err());
    assert_eq!(market_before, unsafe { market.view.borrow_unchecked() });
    assert_eq!(scratch_before, unsafe { scratch.view.borrow_unchecked() });
}

#[test]
fn mvp_partial_fill_preserves_remaining_leaf_and_reserve() {
    let f = fixture();
    place(&f, true, &order_data(1, 0, 10, 100, 0, 101)).unwrap();
    place(&f, false, &order_data(0, 1, 4, 110, 0, 102)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let maker = unsafe { &*(data.as_ptr().add(TRADER_SEAT_OFFSET) as *const TraderSeat) };
    let taker = unsafe {
        &*(data.as_ptr().add(TRADER_SEAT_OFFSET + TRADER_SEAT_SIZE) as *const TraderSeat)
    };
    let maker_position = maker.base_position;
    let taker_position = taker.base_position;
    let maker_reserve = maker.reserved_margin;
    assert_eq!((maker_position, taker_position), (-4, 4));
    assert_eq!(
        maker_reserve,
        stockstream::risk::initial_margin(stockstream::risk::notional(6, 100).unwrap(), 2_000)
            .unwrap()
    );
    let arena = unsafe {
        &*(data.as_ptr().add(stockstream::state::ASK_ARENA_OFFSET)
            as *const stockstream::book::Arena)
    };
    assert_eq!(arena.leaf_counts[0], 1);
    arena.validate().unwrap();
}

#[test]
fn mvp_ioc_partial_fill_leaves_no_taker_residual() {
    let f = fixture();
    place(&f, true, &order_data(1, 0, 4, 100, 0, 111)).unwrap();
    place(&f, false, &order_data(0, 1, 10, 110, 2, 112)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let taker = unsafe {
        &*(data.as_ptr().add(TRADER_SEAT_OFFSET + TRADER_SEAT_SIZE) as *const TraderSeat)
    };
    let position = taker.base_position;
    let reserve = taker.reserved_margin;
    let orders = taker.open_order_count;
    assert_eq!((position, reserve, orders), (4, 0, 0));
    let ask = unsafe {
        &*(data.as_ptr().add(stockstream::state::ASK_ARENA_OFFSET)
            as *const stockstream::book::Arena)
    };
    let bid = unsafe {
        &*(data.as_ptr().add(stockstream::state::BID_ARENA_OFFSET)
            as *const stockstream::book::Arena)
    };
    assert_eq!(ask.leaf_counts[0], 0);
    assert_eq!(bid.leaf_counts[0], 0);
}

#[test]
fn mvp_post_only_crossing_preserves_market_and_scratch() {
    let f = fixture();
    place(&f, true, &order_data(1, 0, 4, 100, 0, 121)).unwrap();
    let market_before = unsafe { f.market.view.borrow_unchecked() }.to_vec();
    let scratch_before = unsafe { f.taker_scratch.view.borrow_unchecked() }.to_vec();
    assert!(place(&f, false, &order_data(0, 1, 4, 110, 1, 122)).is_err());
    assert_eq!(market_before, unsafe { f.market.view.borrow_unchecked() });
    assert_eq!(scratch_before, unsafe {
        f.taker_scratch.view.borrow_unchecked()
    });
}

#[test]
fn mvp_cancellation_releases_exact_remaining_reserve_once() {
    let f = fixture();
    place(&f, true, &order_data(1, 0, 10, 100, 0, 131)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let ask = unsafe {
        &*(data.as_ptr().add(stockstream::state::ASK_ARENA_OFFSET)
            as *const stockstream::book::Arena)
    };
    let handle = ask.roots[0];
    let key = ask.leaf(handle).unwrap().key;
    let before =
        unsafe { &*(data.as_ptr().add(TRADER_SEAT_OFFSET) as *const TraderSeat) }.reserved_margin;
    let mut cancel = vec![4, 0, 0];
    cancel.extend_from_slice(&key.to_le_bytes());
    let mut accounts = [f.market.view.clone(), f.maker.view.clone()];
    process_instruction(&ID, &mut accounts, &cancel).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let seat = unsafe { &*(data.as_ptr().add(TRADER_SEAT_OFFSET) as *const TraderSeat) };
    let reserve = seat.reserved_margin;
    let count = seat.open_order_count;
    assert!(before > 0);
    assert_eq!((reserve, count), (0, 0));
    let ask = unsafe {
        &*(data.as_ptr().add(stockstream::state::ASK_ARENA_OFFSET)
            as *const stockstream::book::Arena)
    };
    ask.validate().unwrap();
    let bytes = data.to_vec();
    assert!(process_instruction(&ID, &mut accounts, &cancel).is_err());
    assert_eq!(bytes, unsafe { f.market.view.borrow_unchecked() });
}

#[test]
fn mvp_reduce_only_increase_rejects_before_mutation() {
    let f = fixture();
    let before = unsafe { f.market.view.borrow_unchecked() }.to_vec();
    assert!(place(&f, false, &order_data(0, 1, 1, 100, 4, 141)).is_err());
    assert_eq!(before, unsafe { f.market.view.borrow_unchecked() });
}

#[test]
fn mvp_event_ring_wraps_from_final_slot_to_zero() {
    let mut f = fixture();
    unsafe {
        let data = f.market.view.borrow_unchecked_mut();
        let header = &mut *(data.as_mut_ptr() as *mut MarketStateHeader);
        header.global_event_sequence = 127;
    }
    place(&f, true, &order_data(1, 0, 1, 100, 0, 151)).unwrap();
    place(&f, false, &order_data(0, 1, 1, 110, 0, 152)).unwrap();
    place(&f, true, &order_data(1, 0, 1, 100, 0, 153)).unwrap();
    place(&f, false, &order_data(0, 1, 1, 110, 0, 154)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let last = unsafe {
        &*(data
            .as_ptr()
            .add(stockstream::state::FILL_EVENT_OFFSET + 127 * stockstream::state::FILL_EVENT_SIZE)
            as *const stockstream::state::FillEvent)
    };
    let zero = unsafe {
        &*(data.as_ptr().add(stockstream::state::FILL_EVENT_OFFSET)
            as *const stockstream::state::FillEvent)
    };
    let last_sequence = last.sequence;
    let zero_sequence = zero.sequence;
    assert_eq!((last_sequence, zero_sequence), (127, 128));
}

#[test]
fn mvp_stale_plan_rejects_changed_maker_and_market_snapshots() {
    let mut f = fixture();
    let (input, header, taker) = prepare_crossing_plan(&mut f);
    let action = {
        let scratch_data = unsafe { f.taker_scratch.view.borrow_unchecked_mut() };
        let scratch = SettlementScratchView::new(scratch_data).unwrap();
        scratch.plan().actions[0]
    };
    {
        let data = unsafe { f.market.view.borrow_unchecked_mut() };
        let ask = unsafe {
            &mut *(data.as_mut_ptr().add(stockstream::state::ASK_ARENA_OFFSET) as *mut Arena)
        };
        unsafe { ask.apply_leaf_quantity_validated(action.handle, action.expected_quantity - 1) };
    }
    let market_before_validate = unsafe { f.market.view.borrow_unchecked().to_vec() };
    let scratch_before_validate = unsafe { f.taker_scratch.view.borrow_unchecked().to_vec() };
    {
        let data = unsafe { f.market.view.borrow_unchecked() };
        let scratch_data = unsafe { f.taker_scratch.view.borrow_unchecked_mut() };
        let scratch = SettlementScratchView::new(scratch_data).unwrap();
        assert!(
            validate_planned_settlement_for_test(data, &scratch, input, header, &taker).is_err()
        );
    }
    assert_eq!(market_before_validate, unsafe {
        f.market.view.borrow_unchecked()
    });
    assert_eq!(scratch_before_validate, unsafe {
        f.taker_scratch.view.borrow_unchecked()
    });

    let mut f = fixture();
    let (input, header, taker) = prepare_crossing_plan(&mut f);
    {
        let data = unsafe { f.market.view.borrow_unchecked_mut() };
        let market = unsafe { &mut *(data.as_mut_ptr() as *mut MarketStateHeader) };
        market.global_event_sequence += 1;
    }
    let market_before_validate = unsafe { f.market.view.borrow_unchecked().to_vec() };
    let scratch_before_validate = unsafe { f.taker_scratch.view.borrow_unchecked().to_vec() };
    {
        let data = unsafe { f.market.view.borrow_unchecked() };
        let scratch_data = unsafe { f.taker_scratch.view.borrow_unchecked_mut() };
        let scratch = SettlementScratchView::new(scratch_data).unwrap();
        assert!(
            validate_planned_settlement_for_test(data, &scratch, input, header, &taker).is_err()
        );
    }
    assert_eq!(market_before_validate, unsafe {
        f.market.view.borrow_unchecked()
    });
    assert_eq!(scratch_before_validate, unsafe {
        f.taker_scratch.view.borrow_unchecked()
    });
}
