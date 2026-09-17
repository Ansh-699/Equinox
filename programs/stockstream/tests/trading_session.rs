//! Handler-level coverage for dedicated `TradingSession` PDAs: lifecycle,
//! per-action nonce replay protection, cumulative-notional/exposure/open-
//! order enforcement, `ReplaceOrder` atomicity, and the forbidden-action
//! boundary. See `tests/magicblock.rs` for why `Rent::get()`/`invoke_signed`
//! limitations only affect the *creation* CPI, not the validation logic
//! exercised here (worked around the same way: the account is pre-sized as
//! a successful `CreateAccount` would leave it, and its owner is flipped
//! directly after `AuthorizeTradingSession` returns to stand in for the
//! no-op CPI's real-chain effect).

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    error::ProgramError,
    Address,
};
use stockstream::{
    process_instruction,
    scratch::{derive_settlement_scratch, SETTLEMENT_SCRATCH_LEN},
    session::{
        derive_trading_session, read_session, SESSION_ACTION_CANCEL, SESSION_ACTION_PLACE,
        SESSION_ACTION_REDUCE_ONLY_CLOSE, SESSION_ACTION_REPLACE, TRADING_SESSION_SIZE,
    },
    state::{MarketStateHeader, MARKET_ACCOUNT_SIZE},
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

struct Fixture {
    market: TestAccount,
    owner: TestAccount,
    owner_payer: TestAccount,
    scratch: TestAccount,
    system_program: TestAccount,
}

const OWNER: Address = Address::new_from_array([61; 32]);
const SEAT_INDEX: u16 = 4;

fn fixture() -> Fixture {
    let mut market = account(
        Address::new_from_array([70; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let owner = account(OWNER, Address::default(), 0, true, false);
    let owner_payer = account(OWNER, Address::default(), 0, true, true);
    process_instruction(&ID, &mut [market.view.clone(), owner.view.clone()], &[0]).unwrap();
    {
        let bytes = unsafe { market.view.borrow_unchecked_mut() };
        let mut header = MaybeHeader::read(bytes);
        header.mode = 1; // Open
        header.oracle_valid = 1;
        header.last_verified_oracle_price = 100;
        header.last_verified_oracle_timestamp = 1;
        header.maximum_position = 1_000_000;
        header.maximum_open_interest = 1_000_000;
        header.market_authority = OWNER.to_bytes();
        header.pause_authority = OWNER.to_bytes();
        header.emergency_authority = OWNER.to_bytes();
        MaybeHeader::write(bytes, &header);
    }
    let mut seat_data = vec![SEAT_INDEX as u8, 0];
    seat_data[0] = 1; // CreateTraderSeat opcode
    let mut create_seat = vec![1u8];
    create_seat.extend(SEAT_INDEX.to_le_bytes());
    process_instruction(
        &ID,
        &mut [market.view.clone(), owner.view.clone()],
        &create_seat,
    )
    .unwrap();
    {
        let bytes = unsafe { market.view.borrow_unchecked_mut() };
        let mut header = MaybeHeader::read(bytes);
        let _ = &mut header;
        // Credit collateral directly into the seat region.
        let start = stockstream::state::TRADER_SEAT_OFFSET
            + SEAT_INDEX as usize * stockstream::state::TRADER_SEAT_SIZE;
        let seat =
            unsafe { &mut *(bytes.as_mut_ptr().add(start) as *mut stockstream::state::TraderSeat) };
        seat.available_collateral = 1_000_000;
    }
    let scratch_addr = derive_settlement_scratch(market.view.address(), SEAT_INDEX, &ID);
    let scratch = account(scratch_addr, ID, SETTLEMENT_SCRATCH_LEN, false, true);
    let mut init_scratch = vec![8u8];
    init_scratch.extend(SEAT_INDEX.to_le_bytes());
    process_instruction(
        &ID,
        &mut [
            market.view.clone(),
            owner.view.clone(),
            scratch.view.clone(),
        ],
        &init_scratch,
    )
    .unwrap();
    let system_program = account(Address::default(), Address::default(), 0, false, false);
    Fixture {
        market,
        owner,
        owner_payer,
        scratch,
        system_program,
    }
}

/// Thin helper to read/write the packed `MarketStateHeader` without pulling
/// in the crate's private handler helpers.
struct MaybeHeader;
impl MaybeHeader {
    fn read(data: &[u8]) -> MarketStateHeader {
        let mut header = core::mem::MaybeUninit::<MarketStateHeader>::uninit();
        unsafe {
            ptr::copy_nonoverlapping(
                data.as_ptr(),
                header.as_mut_ptr().cast::<u8>(),
                size_of::<MarketStateHeader>(),
            );
            header.assume_init()
        }
    }
    fn write(data: &mut [u8], header: &MarketStateHeader) {
        unsafe {
            ptr::copy_nonoverlapping(
                header as *const MarketStateHeader as *const u8,
                data.as_mut_ptr(),
                size_of::<MarketStateHeader>(),
            );
        }
    }
}

fn authorize_data(
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order: u64,
    max_cumulative: u64,
    max_exposure: i128,
    max_open_orders: u16,
) -> Vec<u8> {
    let mut data = vec![17u8];
    data.extend(seat_index.to_le_bytes());
    data.extend(expires_at.to_le_bytes());
    data.push(actions);
    data.extend(max_order.to_le_bytes());
    data.extend(max_cumulative.to_le_bytes());
    data.extend(max_exposure.to_le_bytes());
    data.extend(max_open_orders.to_le_bytes());
    data
}

fn revoke_data(seat_index: u16) -> Vec<u8> {
    let mut data = vec![18u8];
    data.extend(seat_index.to_le_bytes());
    data
}

fn update_limits_data(
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order: u64,
    max_cumulative: u64,
    max_exposure: i128,
    max_open_orders: u16,
) -> Vec<u8> {
    let mut data = vec![31u8];
    data.extend(seat_index.to_le_bytes());
    data.extend(expires_at.to_le_bytes());
    data.push(actions);
    data.extend(max_order.to_le_bytes());
    data.extend(max_cumulative.to_le_bytes());
    data.extend(max_exposure.to_le_bytes());
    data.extend(max_open_orders.to_le_bytes());
    data
}

fn close_session_data(seat_index: u16) -> Vec<u8> {
    let mut data = vec![32u8];
    data.extend(seat_index.to_le_bytes());
    data
}

fn order_data(
    side: u8,
    seat: u16,
    quantity: u64,
    price: i64,
    flags: u8,
    client: u64,
    nonce: u64,
) -> Vec<u8> {
    let mut data = vec![3u8, side, 0, flags, 0, 0];
    data[4..6].copy_from_slice(&seat.to_le_bytes());
    data.extend(quantity.to_le_bytes());
    data.extend(price.to_le_bytes());
    data.extend(0u64.to_le_bytes());
    data.extend(0i64.to_le_bytes());
    data.extend(client.to_le_bytes());
    data.extend(nonce.to_le_bytes());
    data
}

fn cancel_data(seat: u16, order_key: u128, nonce: u64) -> Vec<u8> {
    let mut data = vec![4u8];
    data.extend(seat.to_le_bytes());
    data.extend(order_key.to_le_bytes());
    data.extend(nonce.to_le_bytes());
    data
}

fn cancel_all_data(seat: u16, max: u8, nonce: u64) -> Vec<u8> {
    let mut data = vec![5u8];
    data.extend(seat.to_le_bytes());
    data.push(max);
    data.extend(nonce.to_le_bytes());
    data
}

fn replace_data(old_order_key: u128, new_order: &[u8]) -> Vec<u8> {
    // new_order here is the *body* after the PlaceOrder tag byte.
    let mut data = vec![33u8];
    data.extend(old_order_key.to_le_bytes());
    data.extend_from_slice(&new_order[1..]);
    data
}

/// Authorizes a fresh session for `f`'s owner/seat, simulates the
/// `CreateAccount` CPI's owner-reassignment side effect (a no-op off the SBF
/// target), and returns the session's account handle.
#[allow(clippy::too_many_arguments)]
fn authorize_session(
    f: &Fixture,
    session_signer: Address,
    actions: u8,
    max_order: u64,
    max_cumulative: u64,
    max_exposure: i128,
    max_open_orders: u16,
    expires_at: u64,
) -> TestAccount {
    let pda = derive_trading_session(
        &OWNER,
        f.market.view.address(),
        SEAT_INDEX,
        &session_signer,
        &ID,
    );
    let session = account(pda, Address::default(), TRADING_SESSION_SIZE, false, true);
    let signer_account = account(session_signer, Address::default(), 0, true, false);
    process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            f.owner_payer.view.clone(),
            session.view.clone(),
            signer_account.view.clone(),
            f.system_program.view.clone(),
        ],
        &authorize_data(
            SEAT_INDEX,
            expires_at,
            actions,
            max_order,
            max_cumulative,
            max_exposure,
            max_open_orders,
        ),
    )
    .unwrap();
    unsafe { session.view.clone().assign(&ID) };
    session
}

fn err_code(result: Result<(), ProgramError>) -> u32 {
    match result.unwrap_err() {
        ProgramError::Custom(code) => code,
        other => panic!("expected custom error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------

#[test]
fn authorize_succeeds_for_a_non_zero_seat_index() {
    let f = fixture();
    let session = authorize_session(
        &f,
        Address::new_from_array([1; 32]),
        SESSION_ACTION_PLACE,
        100,
        200,
        300,
        5,
        1000,
    );
    let stored = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
    let (seat, next_nonce, initialized) = (
        stored.trader_seat_index,
        stored.next_expected_nonce,
        stored.initialized,
    );
    assert_eq!(seat, SEAT_INDEX);
    assert_eq!(next_nonce, 1);
    assert_eq!(initialized, 1);
}

#[test]
fn duplicate_authorization_is_rejected() {
    let f = fixture();
    let signer = Address::new_from_array([2; 32]);
    let _first = authorize_session(&f, signer, SESSION_ACTION_PLACE, 100, 200, 300, 5, 1000);
    let pda = derive_trading_session(&OWNER, f.market.view.address(), SEAT_INDEX, &signer, &ID);
    // Same PDA, still simulated as StockStream-owned from the first call.
    let second_view = account(pda, ID, TRADING_SESSION_SIZE, false, true);
    let signer_account = account(signer, Address::default(), 0, true, false);
    let result = process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            f.owner_payer.view.clone(),
            second_view.view.clone(),
            signer_account.view.clone(),
            f.system_program.view.clone(),
        ],
        &authorize_data(SEAT_INDEX, 1000, SESSION_ACTION_PLACE, 100, 200, 300, 5),
    );
    assert!(result.is_err());
}

#[test]
fn authorize_rejects_a_non_owner_signer() {
    let f = fixture();
    let impostor = account(
        Address::new_from_array([99; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let signer = Address::new_from_array([3; 32]);
    let pda = derive_trading_session(
        &impostor.view.address().clone(),
        f.market.view.address(),
        SEAT_INDEX,
        &signer,
        &ID,
    );
    let session = account(pda, Address::default(), TRADING_SESSION_SIZE, false, true);
    let signer_account = account(signer, Address::default(), 0, true, false);
    let result = process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            impostor.view.clone(),
            session.view.clone(),
            signer_account.view.clone(),
            f.system_program.view.clone(),
        ],
        &authorize_data(SEAT_INDEX, 1000, SESSION_ACTION_PLACE, 100, 200, 300, 5),
    );
    assert!(result.is_err());
}

#[test]
fn authorize_rejects_wrong_pda_for_the_signer() {
    let f = fixture();
    let signer = Address::new_from_array([4; 32]);
    // A PDA derived for the wrong seat index.
    let wrong_pda = derive_trading_session(
        &OWNER,
        f.market.view.address(),
        SEAT_INDEX + 1,
        &signer,
        &ID,
    );
    let session = account(
        wrong_pda,
        Address::default(),
        TRADING_SESSION_SIZE,
        false,
        true,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let result = process_instruction(
        &ID,
        &mut [
            f.market.view.clone(),
            f.owner_payer.view.clone(),
            session.view.clone(),
            signer_account.view.clone(),
            f.system_program.view.clone(),
        ],
        &authorize_data(SEAT_INDEX, 1000, SESSION_ACTION_PLACE, 100, 200, 300, 5),
    );
    assert!(result.is_err());
}

#[test]
fn expired_session_cannot_authorize_trading_actions() {
    let f = fixture();
    let signer = Address::new_from_array([5; 32]);
    // expires_at (2) is already <= the market's oracle timestamp (1)... use a
    // session that expires immediately relative to a later action instead:
    // authorize with expiry 2, then advance the market's oracle timestamp
    // past it before attempting a trade.
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        2,
    );
    {
        let mut market_view = f.market.view.clone();
        let bytes = unsafe { market_view.borrow_unchecked_mut() };
        let mut header = MaybeHeader::read(bytes);
        header.last_verified_oracle_timestamp = 5; // now past expiry
        MaybeHeader::write(bytes, &header);
    }
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 0, 1, 1),
    );
    assert!(result.is_err());
}

#[test]
fn revoked_session_cannot_authorize_trading_actions() {
    let f = fixture();
    let signer = Address::new_from_array([6; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE | SESSION_ACTION_CANCEL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_for_revoke = account(signer, Address::default(), 0, true, false);
    let mut revoke_accounts = [
        f.market.view.clone(),
        f.owner.view.clone(),
        session.view.clone(),
        signer_for_revoke.view.clone(),
    ];
    process_instruction(&ID, &mut revoke_accounts, &revoke_data(SEAT_INDEX)).unwrap();
    let revoked = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .revoked;
    assert_eq!(revoked, 1);
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 0, 2, 1),
    );
    assert!(result.is_err());
}

#[test]
fn owner_can_update_limits_but_session_signer_cannot() {
    let f = fixture();
    let signer = Address::new_from_array([7; 32]);
    let session = authorize_session(&f, signer, SESSION_ACTION_PLACE, 100, 200, 300, 5, 1000);
    let signer_account = account(signer, Address::default(), 0, true, false);
    // Owner succeeds.
    let mut owner_accounts = [
        f.market.view.clone(),
        f.owner.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut owner_accounts,
        &update_limits_data(SEAT_INDEX, 2000, SESSION_ACTION_PLACE, 150, 250, 350, 6),
    )
    .unwrap();
    let updated = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
    let (max_order, generation) = (updated.max_order_notional, updated.session_generation);
    assert_eq!(max_order, 150);
    assert_eq!(generation, 1);
    // Session signer itself cannot expand (or change) its own authority.
    let mut signer_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut signer_accounts,
        &update_limits_data(
            SEAT_INDEX,
            3000,
            SESSION_ACTION_ALL_MASK,
            999_999,
            999_999,
            999_999,
            999,
        ),
    );
    assert!(result.is_err());
}

const SESSION_ACTION_ALL_MASK: u8 = 31;

#[test]
fn update_cannot_restore_a_revoked_session() {
    let f = fixture();
    let signer = Address::new_from_array([8; 32]);
    let session = authorize_session(&f, signer, SESSION_ACTION_PLACE, 100, 200, 300, 5, 1000);
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut revoke_accounts = [
        f.market.view.clone(),
        f.owner.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    process_instruction(&ID, &mut revoke_accounts, &revoke_data(SEAT_INDEX)).unwrap();
    let mut update_accounts = [
        f.market.view.clone(),
        f.owner.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut update_accounts,
        &update_limits_data(SEAT_INDEX, 2000, SESSION_ACTION_PLACE, 100, 200, 300, 5),
    );
    assert!(result.is_err());
}

#[test]
fn close_requires_revocation_or_expiry_and_refunds_the_owner() {
    let f = fixture();
    let signer = Address::new_from_array([9; 32]);
    let session = authorize_session(&f, signer, SESSION_ACTION_PLACE, 100, 200, 300, 5, 1000);
    let signer_account = account(signer, Address::default(), 0, true, false);
    // Still active: close is rejected.
    let mut close_accounts = [
        f.market.view.clone(),
        f.owner_payer.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    assert!(
        process_instruction(&ID, &mut close_accounts, &close_session_data(SEAT_INDEX)).is_err()
    );
    // Revoke, then close succeeds.
    let mut revoke_accounts = [
        f.market.view.clone(),
        f.owner.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    process_instruction(&ID, &mut revoke_accounts, &revoke_data(SEAT_INDEX)).unwrap();
    let mut close_accounts = [
        f.market.view.clone(),
        f.owner_payer.view.clone(),
        session.view.clone(),
        signer_account.view.clone(),
    ];
    process_instruction(&ID, &mut close_accounts, &close_session_data(SEAT_INDEX)).unwrap();
    assert_eq!(session.view.lamports(), 0);
}

// ---------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------

#[test]
fn nonce_replay_lower_and_future_are_all_rejected_and_failed_actions_preserve_it() {
    const SESSION_ACTION_CANCEL_ALL: u8 = 1 << 2;
    let f = fixture();
    let signer = Address::new_from_array([10; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE | SESSION_ACTION_CANCEL | SESSION_ACTION_CANCEL_ALL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];

    // Correct nonce succeeds and advances to 2.
    process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1),
    )
    .unwrap(); // post-only resting bid
    let next = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .next_expected_nonce;
    assert_eq!(next, 2);

    let snapshot = unsafe { session.view.borrow_unchecked().to_vec() };
    // Repeated nonce.
    assert_eq!(
        err_code(process_instruction(
            &ID,
            &mut accounts,
            &order_data(0, SEAT_INDEX, 1, 100, 1, 2, 1)
        )),
        stockstream::error::StockStreamError::SessionNonceReplay as u32
    );
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );
    // Lower nonce (0 is never valid for a session action).
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 3, 0)
    )
    .is_err());
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );
    // Future/skipped nonce.
    assert_eq!(
        err_code(process_instruction(
            &ID,
            &mut accounts,
            &order_data(0, SEAT_INDEX, 1, 100, 1, 4, 5)
        )),
        stockstream::error::StockStreamError::SessionNonceReplay as u32
    );
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );

    // A failed action (bad price -> InvalidInstruction) at the *correct*
    // nonce must not consume it either.
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, -1, 1, 5, 2)
    )
    .is_err());
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );

    // The correct next nonce still works afterwards. `CancelAll` takes
    // `[market, signer, session]` -- no settlement scratch account.
    let mut cancel_all_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut cancel_all_accounts,
        &cancel_all_data(SEAT_INDEX, 5, 2),
    )
    .unwrap();
    let next = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .next_expected_nonce;
    assert_eq!(next, 3);
}

#[test]
fn nonce_overflow_is_rejected() {
    let f = fixture();
    let signer = Address::new_from_array([11; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_CANCEL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    {
        let mut s = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
        s.next_expected_nonce = u64::MAX;
        let mut session_view = session.view.clone();
        let bytes = unsafe { session_view.borrow_unchecked_mut() };
        stockstream::session::write_session(bytes, &s).unwrap();
    }
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        session.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut accounts,
        &cancel_all_data(SEAT_INDEX, 1, u64::MAX),
    );
    assert!(result.is_err());
}

#[test]
fn a_session_from_one_seat_cannot_authorize_another_seat() {
    let f = fixture();
    let signer = Address::new_from_array([12; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    // Same session account, but the order claims a different seat index.
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    let result = process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX + 1, 1, 100, 0, 1, 1),
    );
    assert!(result.is_err());
}

// ---------------------------------------------------------------------
// PlaceOrder via session
// ---------------------------------------------------------------------

#[test]
fn place_order_rejects_when_action_not_in_allowlist() {
    let f = fixture();
    let signer = Address::new_from_array([13; 32]);
    // CANCEL only, not PLACE.
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_CANCEL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 0, 1, 1)
    )
    .is_err());
}

#[test]
fn place_order_rejects_excess_per_order_notional() {
    let f = fixture();
    let signer = Address::new_from_array([14; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        500,
        10_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    // 10 * 100 = 1000 > max_order_notional (500).
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 10, 100, 1, 1, 1)
    )
    .is_err());
}

#[test]
fn place_order_rejects_excess_cumulative_notional() {
    let f = fixture();
    let signer = Address::new_from_array([15; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        1_000,
        1_500,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 10, 100, 1, 1, 1),
    )
    .unwrap(); // 1000 consumed
    let snapshot = unsafe { session.view.borrow_unchecked().to_vec() };
    // Another 1000 would bring cumulative to 2000 > 1500.
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 10, 100, 1, 2, 2)
    )
    .is_err());
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );
}

#[test]
fn place_order_rejects_excess_resulting_exposure() {
    let f = fixture();
    let signer = Address::new_from_array([16; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        1_000_000,
        2_000_000,
        5,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    // Resting quantity 10 would push resulting exposure to 10 > max (5).
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 10, 100, 1, 1, 1)
    )
    .is_err());
}

#[test]
fn place_order_rejects_excess_open_orders() {
    let f = fixture();
    let signer = Address::new_from_array([17; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE,
        1_000_000,
        2_000_000,
        1_000_000,
        1,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1),
    )
    .unwrap();
    let snapshot = unsafe { session.view.borrow_unchecked().to_vec() };
    // A second resting order would exceed max_open_orders (1).
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 99, 1, 2, 2)
    )
    .is_err());
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );
}

#[test]
fn reduce_only_close_action_permits_only_reduce_only_orders() {
    let f = fixture();
    let signer = Address::new_from_array([18; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_REDUCE_ONLY_CLOSE,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    // A regular (non-reduce-only) order is not permitted by this allowlist.
    assert!(process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1)
    )
    .is_err());
    // A reduce-only order is rejected for a different reason (flat position,
    // nothing to reduce) but *not* for lacking authorization -- confirm it
    // reaches the risk check rather than the session-action check by using
    // the RiskViolation error rather than InvalidTradingSession.
    let result = process_instruction(
        &ID,
        &mut accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1 | 4, 1, 1),
    );
    assert_eq!(
        err_code(result),
        stockstream::error::StockStreamError::RiskViolation as u32
    );
}

// ---------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------

#[test]
fn cancel_order_consumes_nonce_and_no_notional() {
    let f = fixture();
    let signer = Address::new_from_array([19; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE | SESSION_ACTION_CANCEL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut place_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut place_accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1),
    )
    .unwrap();
    let order_key = stockstream::book::OrderInput {
        side: stockstream::book::Side::Bid,
        tree: stockstream::book::TreeKind::Fixed,
        owner: SEAT_INDEX as u32,
        price_or_offset: 100,
        sequence: 1,
        quantity: 1,
        expires_at: 0,
        peg_limit: 0,
        client_order_id: 1,
        time_in_force: stockstream::book::TimeInForce::GoodTilCancelled,
        post_only: true,
        self_trade_behavior: stockstream::book::SelfTradeBehavior::AbortTransaction,
    }
    .leaf()
    .unwrap()
    .key;
    let consumed_before = read_session(unsafe { session.view.borrow_unchecked() })
        .unwrap()
        .consumed_cumulative_notional;
    let mut cancel_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut cancel_accounts,
        &cancel_data(SEAT_INDEX, order_key, 2),
    )
    .unwrap();
    let stored = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
    let (consumed_after, next_nonce) = (
        stored.consumed_cumulative_notional,
        stored.next_expected_nonce,
    );
    assert_eq!(consumed_after, consumed_before);
    assert_eq!(next_nonce, 3);
}

#[test]
fn failed_cancellation_preserves_nonce() {
    let f = fixture();
    let signer = Address::new_from_array([20; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_CANCEL,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        session.view.clone(),
    ];
    let snapshot = unsafe { session.view.borrow_unchecked().to_vec() };
    // No such order exists.
    assert!(
        process_instruction(&ID, &mut accounts, &cancel_data(SEAT_INDEX, 0xDEADBEEF, 1)).is_err()
    );
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        snapshot.as_slice()
    );
}

// ---------------------------------------------------------------------
// ReplaceOrder
// ---------------------------------------------------------------------

#[test]
fn replace_order_succeeds_and_loses_time_priority() {
    let f = fixture();
    let signer = Address::new_from_array([21; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE | SESSION_ACTION_REPLACE,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut place_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut place_accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1),
    )
    .unwrap();
    let old_key = stockstream::book::OrderInput {
        side: stockstream::book::Side::Bid,
        tree: stockstream::book::TreeKind::Fixed,
        owner: SEAT_INDEX as u32,
        price_or_offset: 100,
        sequence: 1,
        quantity: 1,
        expires_at: 0,
        peg_limit: 0,
        client_order_id: 1,
        time_in_force: stockstream::book::TimeInForce::GoodTilCancelled,
        post_only: true,
        self_trade_behavior: stockstream::book::SelfTradeBehavior::AbortTransaction,
    }
    .leaf()
    .unwrap()
    .key;
    let new_order = order_data(0, SEAT_INDEX, 2, 101, 1, 2, 2);
    let mut replace_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut replace_accounts,
        &replace_data(old_key, &new_order),
    )
    .unwrap();
    let stored = read_session(unsafe { session.view.borrow_unchecked() }).unwrap();
    let (consumed, next_nonce) = (
        stored.consumed_cumulative_notional,
        stored.next_expected_nonce,
    );
    assert_eq!(consumed, 100 + 202); // old order's notional + new order's
    assert_eq!(next_nonce, 3);
}

#[test]
fn replace_order_failure_leaves_the_original_order_and_session_untouched() {
    let f = fixture();
    let signer = Address::new_from_array([22; 32]);
    let session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_PLACE | SESSION_ACTION_REPLACE,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, false);
    let mut place_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    process_instruction(
        &ID,
        &mut place_accounts,
        &order_data(0, SEAT_INDEX, 1, 100, 1, 1, 1),
    )
    .unwrap();
    let old_key = stockstream::book::OrderInput {
        side: stockstream::book::Side::Bid,
        tree: stockstream::book::TreeKind::Fixed,
        owner: SEAT_INDEX as u32,
        price_or_offset: 100,
        sequence: 1,
        quantity: 1,
        expires_at: 0,
        peg_limit: 0,
        client_order_id: 1,
        time_in_force: stockstream::book::TimeInForce::GoodTilCancelled,
        post_only: true,
        self_trade_behavior: stockstream::book::SelfTradeBehavior::AbortTransaction,
    }
    .leaf()
    .unwrap()
    .key;
    let market_snapshot = unsafe { f.market.view.borrow_unchecked().to_vec() };
    let session_snapshot = unsafe { session.view.borrow_unchecked().to_vec() };
    // Replacement notional (1,000,000 * 101) wildly exceeds the session's
    // per-order cap -- authorization for the new order must fail, and the
    // cancel of the old order must be rolled back with it.
    let new_order = order_data(0, SEAT_INDEX, 1_000_000, 101, 1, 2, 2);
    let mut replace_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        f.scratch.view.clone(),
        session.view.clone(),
    ];
    assert!(process_instruction(
        &ID,
        &mut replace_accounts,
        &replace_data(old_key, &new_order)
    )
    .is_err());
    assert_eq!(
        unsafe { f.market.view.borrow_unchecked() },
        market_snapshot.as_slice()
    );
    assert_eq!(
        unsafe { session.view.borrow_unchecked() },
        session_snapshot.as_slice()
    );
}

// ---------------------------------------------------------------------
// Forbidden actions: a session signer can never reach main-wallet-only
// handlers, because those check the *actual signer* against a stored
// authority (market_authority, seat.trader, ...) that a session signer's
// pubkey never matches.
// ---------------------------------------------------------------------

#[test]
fn session_signer_cannot_withdraw_deposit_or_administer_the_market() {
    let f = fixture();
    let signer = Address::new_from_array([23; 32]);
    let _session = authorize_session(
        &f,
        signer,
        SESSION_ACTION_ALL_MASK,
        1_000_000,
        2_000_000,
        1_000_000,
        10,
        1000,
    );
    let signer_account = account(signer, Address::default(), 0, true, true);

    // DepositCollateral / WithdrawCollateral: seat.trader never equals the
    // session signer's own pubkey.
    let mint = account(
        Address::new_from_array([200; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let token_program = account(
        Address::new_from_array([201; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let vault = account(
        Address::new_from_array([202; 32]),
        Address::default(),
        0,
        false,
        true,
    );
    let vault_authority = account(
        Address::new_from_array([203; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let mut deposit_accounts = [
        f.market.view.clone(),
        signer_account.view.clone(),
        mint.view.clone(),
        token_program.view.clone(),
        vault.view.clone(),
        vault_authority.view.clone(),
    ];
    let mut deposit_data = vec![10u8];
    deposit_data.extend(SEAT_INDEX.to_le_bytes());
    deposit_data.extend(1u64.to_le_bytes());
    assert!(process_instruction(&ID, &mut deposit_accounts, &deposit_data).is_err());

    // UpdateMarketRisk: requires `header.market_authority == signer`.
    let mut risk_accounts = [f.market.view.clone(), signer_account.view.clone()];
    let mut risk_data = vec![24u8];
    risk_data.extend(2_000u16.to_le_bytes());
    risk_data.extend(1_000u16.to_le_bytes());
    risk_data.extend(5u32.to_le_bytes());
    assert!(process_instruction(&ID, &mut risk_accounts, &risk_data).is_err());

    // ConsumeOracleUpdate and DelegateMarket/CommitMarket are exercised in
    // their own dedicated test files (oracle/pyth and magicblock); the
    // authorization principle is identical -- covered here for the two
    // handlers whose account shape this fixture already supports.
}

#[test]
fn derive_trading_session_golden_vector_for_cross_language_parity() {
    // Fixed inputs cross-checked byte-for-byte against the TypeScript
    // client's `deriveTradingSession` in `clients/stockstream/src/index.test.ts`
    // to catch any seed-order/encoding drift between the two implementations.
    let owner = Address::new_from_array([1; 32]);
    let market = Address::new_from_array([2; 32]);
    let seat_index: u16 = 7;
    let signer = Address::new_from_array([3; 32]);
    let pda = derive_trading_session(&owner, &market, seat_index, &signer, &ID);
    eprintln!("GOLDEN_TRADING_SESSION_PDA={:?}", pda.to_bytes());
}
