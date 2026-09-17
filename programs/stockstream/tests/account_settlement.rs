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

#[test]
fn registry_update_and_suspend_preserve_feed_configuration() {
    use stockstream::registry::{derive_instrument, EXCHANGE_SIZE, INSTRUMENT_SIZE};
    let owner = account(
        Address::new_from_array([81; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let exchange = account(
        Address::new_from_array([82; 32]),
        ID,
        EXCHANGE_SIZE,
        false,
        true,
    );
    process_instruction(&ID, &mut [exchange.view.clone(), owner.view.clone()], &[19]).unwrap();
    let id = [83; 32];
    let instrument = account(
        derive_instrument(&ID, exchange.view.address(), &id),
        ID,
        INSTRUMENT_SIZE,
        false,
        true,
    );
    let mut register = vec![20];
    register.extend(id);
    let mut accounts = [
        exchange.view.clone(),
        instrument.view.clone(),
        owner.view.clone(),
    ];
    process_instruction(&ID, &mut accounts, &register).unwrap();
    let mut update = vec![22];
    update.extend(id);
    update.extend(42u32.to_le_bytes());
    update.push(1);
    update.extend((-8i32).to_le_bytes());
    process_instruction(&ID, &mut accounts, &update).unwrap();
    let bytes = unsafe { instrument.view.borrow_unchecked() };
    assert_eq!(&bytes[75..79], &42u32.to_le_bytes());
    assert_eq!(bytes[79], 1);
    assert_eq!(&bytes[107..111], &(-8i32).to_le_bytes());
    let mut suspend = vec![23];
    suspend.extend(id);
    process_instruction(&ID, &mut accounts, &suspend).unwrap();
    let bytes = unsafe { instrument.view.borrow_unchecked() };
    assert_eq!(&bytes[75..79], &42u32.to_le_bytes());
    assert_eq!(bytes[79], 1);
    assert_eq!(bytes[111], 1);
}

#[test]
fn created_market_copies_reviewed_instrument_oracle_configuration() {
    use stockstream::registry::{
        derive_instrument, derive_perp_market, EXCHANGE_SIZE, INSTRUMENT_SIZE,
    };
    let owner = account(
        Address::new_from_array([87; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let exchange = account(
        Address::new_from_array([88; 32]),
        ID,
        EXCHANGE_SIZE,
        false,
        true,
    );
    process_instruction(&ID, &mut [exchange.view.clone(), owner.view.clone()], &[19]).unwrap();
    let id = [89; 32];
    let instrument = account(
        derive_instrument(&ID, exchange.view.address(), &id),
        ID,
        INSTRUMENT_SIZE,
        false,
        true,
    );
    let mut register = vec![20];
    register.extend(id);
    process_instruction(
        &ID,
        &mut [
            exchange.view.clone(),
            instrument.view.clone(),
            owner.view.clone(),
        ],
        &register,
    )
    .unwrap();
    let mut update = vec![22];
    update.extend(id);
    update.extend(77u32.to_le_bytes());
    update.push(1);
    update.extend((-6i32).to_le_bytes());
    process_instruction(
        &ID,
        &mut [
            exchange.view.clone(),
            instrument.view.clone(),
            owner.view.clone(),
        ],
        &update,
    )
    .unwrap();
    let market = account(
        derive_perp_market(&ID, instrument.view.address()),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let mut create = vec![21];
    create.extend(id);
    process_instruction(
        &ID,
        &mut [
            instrument.view.clone(),
            market.view.clone(),
            owner.view.clone(),
        ],
        &create,
    )
    .unwrap();
    let data = unsafe { market.view.borrow_unchecked() };
    assert_eq!(&data[327 + 64..327 + 68], &77u32.to_le_bytes());
    assert_eq!(data[327 + 68], 1);
    let exponent = core::mem::offset_of!(MarketStateHeader, price_exponent);
    assert_eq!(&data[exponent..exponent + 4], &(-6i32).to_le_bytes());
}

#[test]
fn trading_session_is_bound_to_the_owners_actual_seat_and_can_be_revoked() {
    use stockstream::session::{derive_trading_session, read_session, TRADING_SESSION_SIZE};

    let f = fixture();
    // `fixture()`'s maker is a signer but not writable (it never pays for
    // anything in the existing fixtures). `AuthorizeTradingSession` debits
    // the owner to fund the session PDA's rent, so it needs its own
    // writable handle to the same address.
    let owner_payer = account(*f.maker.view.address(), Address::default(), 0, true, true);
    let session_signer_addr = Address::new_from_array([90; 32]);
    let session_signer = account(session_signer_addr, Address::default(), 0, true, false);
    let session_pda = derive_trading_session(
        f.maker.view.address(),
        f.market.view.address(),
        0,
        &session_signer_addr,
        &ID,
    );
    // Not yet owned by StockStream: `AuthorizeTradingSession` creates it via
    // a System Program CPI, which is a no-op off the SBF target, so the test
    // account is pre-sized/pre-funded the way a successful CPI would leave
    // it and we assert on the surrounding validation/write logic instead.
    let session = account(
        session_pda,
        Address::default(),
        TRADING_SESSION_SIZE,
        false,
        true,
    );
    let mut authorize = vec![17];
    authorize.extend(0u16.to_le_bytes()); // seat_index
    authorize.extend(2u64.to_le_bytes()); // expires_at
    authorize.push(3); // actions: PLACE | CANCEL
    authorize.extend(1_000u64.to_le_bytes()); // max_order_notional
    authorize.extend(2_000u64.to_le_bytes()); // max_cumulative_notional
    authorize.extend(3_000i128.to_le_bytes()); // maximum_exposure
    authorize.extend(4u16.to_le_bytes()); // maximum_open_orders
    let system_program = account(Address::default(), Address::default(), 0, false, false);
    process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            owner_payer.view.clone(),
            session.view.clone(),
            session_signer.view.clone(),
            system_program.view.clone(),
        ],
        &authorize,
    )
    .unwrap();
    // `CreateAccount::invoke_signed` is a no-op off the SBF target (see
    // `magicblock.rs`'s module doc), so it never actually reassigns the
    // account's owner the way it would on a real cluster. Apply that one
    // side effect directly so the rest of this test can exercise the real
    // post-creation validation path.
    unsafe { session.view.clone().assign(&ID) };
    let stored = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
    let (discriminator, owner, signer_field, seat_index, next_nonce) = (
        stored.discriminator,
        stored.owner,
        stored.session_signer,
        stored.trader_seat_index,
        stored.next_expected_nonce,
    );
    assert_eq!(&discriminator, b"STKSES02");
    assert_eq!(owner, f.maker.view.address().to_bytes());
    assert_eq!(signer_field, session_signer_addr.to_bytes());
    assert_eq!(seat_index, 0);
    assert_eq!(next_nonce, 1);

    let mut place_accounts = [
        f.market.view.clone(),
        session_signer.view.clone(),
        f.maker_scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut place_accounts,
        &order_data_with_nonce(1, 0, 1, 100, 0, 990, 1),
    )
    .unwrap();
    let consumed = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .consumed_cumulative_notional;
    assert_eq!(consumed, 100);
    process_instruction(
        &ID,
        &mut place_accounts,
        &order_data_with_nonce(1, 0, 10, 100, 0, 991, 2),
    )
    .unwrap();
    let next_nonce = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .next_expected_nonce;
    assert_eq!(next_nonce, 3);
    let before_replay = unsafe { session.view.borrow_unchecked().to_vec() };
    // Repeated nonce.
    assert!(process_instruction(
        &ID,
        &mut place_accounts,
        &order_data_with_nonce(1, 0, 1, 100, 0, 991, 2),
    )
    .is_err());
    assert_eq!(unsafe { session.view.borrow_unchecked() }, before_replay);
    // Future/skipped nonce.
    assert!(process_instruction(
        &ID,
        &mut place_accounts,
        &order_data_with_nonce(1, 0, 1, 100, 0, 991, 10),
    )
    .is_err());
    let before_rejected = unsafe { session.view.borrow_unchecked().to_vec() };
    // Disallowed action for this session (CANCEL_ALL was never granted).
    assert!(process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            session_signer.view.clone(),
            session.view.clone(),
        ],
        &[5, 0, 0, 5, 3, 0, 0, 0, 0, 0, 0, 0],
    )
    .is_err());
    assert_eq!(unsafe { session.view.borrow_unchecked() }, before_rejected);
    let mut revoke = vec![18];
    revoke.extend(0u16.to_le_bytes());
    process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            f.maker.view.clone(),
            session.view.clone(),
            session_signer.view.clone(),
        ],
        &revoke,
    )
    .unwrap();
    assert_eq!(
        read_session(unsafe { session.view.borrow_unchecked() })
            .unwrap()
            .revoked,
        1
    );
    // A revoked session can no longer authorize any trading action.
    assert!(process_instruction(
        &ID,
        &mut place_accounts,
        &order_data_with_nonce(1, 0, 1, 100, 0, 993, 3),
    )
    .is_err());
}

#[test]
fn forged_exchange_owner_cannot_register_instrument() {
    use stockstream::registry::{derive_instrument, EXCHANGE_SIZE, INSTRUMENT_SIZE};
    let owner = account(
        Address::new_from_array([84; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let mut exchange = account(
        Address::new_from_array([85; 32]),
        Address::default(),
        EXCHANGE_SIZE,
        false,
        true,
    );
    unsafe {
        let data = exchange.view.borrow_unchecked_mut();
        data[..8].copy_from_slice(b"STKEXC01");
        data[8] = 1;
        data[10] = 1;
        data[11..43].copy_from_slice(owner.view.address().as_ref());
    }
    let id = [86; 32];
    let instrument = account(
        derive_instrument(&ID, exchange.view.address(), &id),
        ID,
        INSTRUMENT_SIZE,
        false,
        true,
    );
    let before = unsafe { instrument.view.borrow_unchecked().to_vec() };
    let mut register = vec![20];
    register.extend(id);
    assert!(process_instruction(
        &ID,
        &mut [
            exchange.view.clone(),
            instrument.view.clone(),
            owner.view.clone()
        ],
        &register
    )
    .is_err());
    assert_eq!(unsafe { instrument.view.borrow_unchecked() }, before);
}

#[test]
fn market_decoder_offsets_match_packed_rust_layout() {
    assert_eq!(core::mem::offset_of!(MarketStateHeader, oracle_valid), 294);
    assert_eq!(
        core::mem::offset_of!(MarketStateHeader, last_verified_oracle_price),
        295
    );
    assert_eq!(
        core::mem::offset_of!(MarketStateHeader, bid_arena_offset),
        311
    );
    assert_eq!(
        core::mem::offset_of!(MarketStateHeader, reserved_upgrade),
        327
    );
}

/// Golden vector: the absolute byte offsets of the Priority-4 custody
/// ledger fields, cross-checked against the hardcoded offsets
/// `clients/stockstream/src/index.ts::decodeMarketState` reads
/// (`449, 457, 465, 473, 474`). `reserved_upgrade` starts at `327`
/// (asserted above); these are `327 + RESERVED_*` from `state.rs`.
#[test]
fn custody_ledger_field_offsets_match_the_typescript_decoder() {
    const RESERVED_UPGRADE_OFFSET: usize = 327;
    assert_eq!(
        RESERVED_UPGRADE_OFFSET + stockstream::state::RESERVED_PROTOCOL_FEE_BALANCE,
        449
    );
    assert_eq!(
        RESERVED_UPGRADE_OFFSET + stockstream::state::RESERVED_INSURANCE_FUND_BALANCE,
        457
    );
    assert_eq!(
        RESERVED_UPGRADE_OFFSET + stockstream::state::RESERVED_RECOGNIZED_BAD_DEBT,
        465
    );
    assert_eq!(
        RESERVED_UPGRADE_OFFSET + stockstream::state::RESERVED_RECONCILIATION_STATUS,
        473
    );
    assert_eq!(
        RESERVED_UPGRADE_OFFSET + stockstream::state::RESERVED_VAULT_SURPLUS,
        474
    );
}

/// `MARKET_VERSION` was bumped from `1` to `2` when the custody ledger
/// fields above became permanent (Priority 4, see `state.rs`); a
/// `1`-tagged account must be rejected outright, not silently reinterpreted
/// under the new layout.
#[test]
fn a_version_one_market_header_is_rejected_after_the_layout_bump() {
    let mut market = account(
        Address::new_from_array([95; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let authority = account(
        Address::new_from_array([96; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    process_instruction(
        &ID,
        &mut [market.view.clone(), authority.view.clone()],
        &[0],
    )
    .unwrap();
    {
        let data = unsafe { market.view.borrow_unchecked_mut() };
        data[8..10].copy_from_slice(&1u16.to_le_bytes());
    }
    assert!(process_instruction(
        &ID,
        &mut [market.view.clone(), authority.view.clone()],
        &[1, 0, 0]
    )
    .is_err());
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
    order_data_with_nonce(side, seat, quantity, price, flags, client, 0)
}

fn order_data_with_nonce(
    side: u8,
    seat: u16,
    quantity: u64,
    price: i64,
    flags: u8,
    client: u64,
    action_nonce: u64,
) -> Vec<u8> {
    let mut data = vec![3, side, 0, flags, 0, 0];
    data[4..6].copy_from_slice(&seat.to_le_bytes());
    data.extend_from_slice(&quantity.to_le_bytes());
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes());
    data.extend_from_slice(&client.to_le_bytes());
    data.extend_from_slice(&action_nonce.to_le_bytes());
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
    maker_order.extend_from_slice(&0u64.to_le_bytes());
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
    // 2 (TraderSeatCreated for each of the two seats) + 1 (maker's
    // OrderPlaced) + 1 (taker's OrderPlaced) + 1 (the fill itself, no fee
    // credited since this test's smaller notional floors to a zero taker
    // fee -- see `crossing_fill_credits_the_protocol_fee_ledger`).
    assert_eq!(event_sequence, 5);
    // The fill-event ring is a modular buffer keyed by the *shared*
    // protocol-wide event sequence (`global_event_sequence`), not a
    // fill-only counter that always starts at 0 -- the two preceding
    // `TraderSeatCreated` events already advanced it, so this fill's own
    // sequence is `event_sequence - 1`, landing at that ring slot, not
    // necessarily slot 0.
    let fill_sequence = event_sequence - 1;
    let event_offset = stockstream::state::FILL_EVENT_OFFSET
        + (fill_sequence as usize % stockstream::state::FILL_EVENT_CAPACITY)
            * stockstream::state::FILL_EVENT_SIZE;
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

/// Priority 4: a crossing fill's maker+taker fee (already deducted from
/// each seat's `realized_pnl` by `risk::apply_fill`) must also be credited
/// to the market-level protocol fee ledger -- previously it was deducted
/// and never credited anywhere. Uses a large enough notional (price 1000 x
/// quantity 1000) that the default `taker_fee_bps = 5` produces a nonzero,
/// exactly predictable fee (1_000_000 * 5 / 10_000 = 500), unlike the
/// smaller-notional crossing test above where integer division floors the
/// fee to zero.
#[test]
fn crossing_fill_credits_the_protocol_fee_ledger() {
    let authority = Address::new_from_array([27; 32]);
    let trader_b = Address::new_from_array([28; 32]);
    let mut market = account(
        Address::new_from_array([29; 32]),
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
    let scratch_b = account(
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
    credit(&mut market, 0, 10_000_000);
    credit(&mut market, 1, 10_000_000);
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
    maker_order.extend_from_slice(&1_000u64.to_le_bytes());
    maker_order.extend_from_slice(&1_000i64.to_le_bytes());
    maker_order.extend_from_slice(&0u64.to_le_bytes());
    maker_order.extend_from_slice(&0i64.to_le_bytes());
    maker_order.extend_from_slice(&21u64.to_le_bytes());
    maker_order.extend_from_slice(&0u64.to_le_bytes());
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
    taker_order[38..46].copy_from_slice(&22u64.to_le_bytes());
    {
        let mut accounts = [
            market.view.clone(),
            signer_b.view.clone(),
            scratch_b.view.clone(),
        ];
        process_instruction(&ID, &mut accounts, &taker_order).unwrap();
    }
    let data = unsafe { market.view.borrow_unchecked() };
    let header = unsafe { &*(data.as_ptr() as *const MarketStateHeader) };
    let protocol_fee_balance = header.protocol_fee_balance();
    // The fee-crediting branch shares the market's fill-event sequence
    // counter, so it must also have advanced past the fill's own increment,
    // not reset or duplicate it: 2 (TraderSeatCreated x2) + 1 (maker's
    // OrderPlaced) + 1 (taker's OrderPlaced) + 1 (the fill) + 1
    // (ProtocolFeesChanged).
    let event_sequence = header.global_event_sequence;
    assert_eq!(protocol_fee_balance, 500);
    assert_eq!(event_sequence, 6);
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
        &[
            4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
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
    cancel.extend_from_slice(&0u64.to_le_bytes());
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
    // Every placed order now also emits its own `OrderPlaced` event (see
    // `events.rs`), emitted only after settlement succeeds -- its sequence
    // is reserved *after* any fills the same instruction produced, via
    // `next_event_sequence`. Fills *within a single instruction* still get
    // consecutive sequences (`plan_seat_results` assigns
    // `header.global_event_sequence + 1 + fill_index`, `+1` because that
    // field holds the *last used* sequence, not the next available one),
    // so this test crosses two resting makers with a single two-quantity
    // taker order to get an exact, adjacent (127, 128) fill pair spanning
    // the ring's wrap point.
    let mut f = fixture();
    unsafe {
        let data = f.market.view.borrow_unchecked_mut();
        let header = &mut *(data.as_mut_ptr() as *mut MarketStateHeader);
        header.global_event_sequence = 124;
    }
    place(&f, true, &order_data(1, 0, 1, 100, 0, 151)).unwrap(); // maker ask #1, OrderPlaced -> 125
    place(&f, true, &order_data(1, 0, 1, 100, 0, 152)).unwrap(); // maker ask #2, OrderPlaced -> 126
                                                                 // Taker bid crosses both resting asks in one instruction: fill #1 = 127,
                                                                 // fill #2 = 128 (wraps to slot 0), then its own OrderPlaced takes 129.
    place(&f, false, &order_data(0, 1, 2, 110, 0, 153)).unwrap();
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

/// Regression test for a real sequence-collision bug: `global_event_sequence`
/// holds the *last used* sequence (every non-fill event kind assigns via
/// `next_event_sequence`'s increment-then-assign convention), so a fill
/// sequence formula that reused that value directly as its own 0-indexed
/// base (instead of `+ 1`) would silently collide with whatever event last
/// advanced the counter -- here, a resting order's own trailing
/// `OrderPlaced` immediately followed by a second order that crosses it.
#[test]
fn a_resting_orders_placed_event_never_collides_with_a_later_crossing_fills_sequence() {
    let f = fixture();
    place(&f, true, &order_data(1, 0, 5, 100, 0, 161)).unwrap();
    let maker_placed_sequence = {
        let data = unsafe { f.market.view.borrow_unchecked() };
        unsafe { &*(data.as_ptr() as *const MarketStateHeader) }.global_event_sequence
    };
    place(&f, false, &order_data(0, 1, 5, 110, 0, 162)).unwrap();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let header = unsafe { &*(data.as_ptr() as *const MarketStateHeader) };
    let final_sequence = header.global_event_sequence;
    // The fill's own sequence is `final_sequence - 1` (the taker's trailing
    // OrderPlaced took the very last slot); it must be strictly greater
    // than the maker's OrderPlaced sequence, never equal to it.
    let fill_sequence = final_sequence - 1;
    assert!(fill_sequence > maker_placed_sequence);
    let event_offset = stockstream::state::FILL_EVENT_OFFSET
        + (fill_sequence as usize % stockstream::state::FILL_EVENT_CAPACITY)
            * stockstream::state::FILL_EVENT_SIZE;
    let event =
        unsafe { &*(data.as_ptr().add(event_offset) as *const stockstream::state::FillEvent) };
    let event_sequence = event.sequence;
    assert_eq!(event_sequence, fill_sequence);
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
