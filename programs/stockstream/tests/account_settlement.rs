use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    process_instruction,
    scratch::{derive_settlement_scratch, SETTLEMENT_SCRATCH_LEN},
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
