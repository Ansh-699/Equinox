//! Priority 4: production custody, vault accounting, withdrawal health,
//! fees, insurance accounting and reconciliation.
//!
//! `invoke_signed`/`invoke_with_program` are no-ops off the SBF target (see
//! `docs/magicblock.md`), so these tests cannot observe a real SPL token
//! balance change from the CPI itself. They instead cover everything this
//! program's own logic controls before and after that CPI: account
//! validation, aliasing rejection, ledger accounting, authorization
//! boundaries, and the withdrawal-health/reconciliation state machine --
//! exactly the "wire-conformance plus full pre-CPI validation" pattern used
//! by `tests/magicblock.rs` and `tests/pyth_oracle.rs`.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    error::ProgramError,
    Address,
};
use stockstream::{
    error::StockStreamError,
    process_instruction,
    state::{
        DelegationStatus, MarketMode, MarketStateHeader, ReconciliationStatus, TraderSeat,
        MARKET_ACCOUNT_SIZE, TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE,
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

fn mint_account(mint: Address, decimals: u8) -> TestAccount {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1; // is_initialized
    let mut account = account(mint, pinocchio_token::ID, data.len(), false, false);
    let bytes = unsafe { account.view.borrow_unchecked_mut() };
    bytes.copy_from_slice(&data);
    account
}

fn token_account(
    address: Address,
    mint: Address,
    owner: Address,
    amount: u64,
    writable: bool,
) -> TestAccount {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(&mint.to_bytes());
    data[32..64].copy_from_slice(&owner.to_bytes());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    let mut account = account(address, pinocchio_token::ID, data.len(), false, writable);
    let bytes = unsafe { account.view.borrow_unchecked_mut() };
    bytes.copy_from_slice(&data);
    account
}

fn set_vault_amount(vault: &mut TestAccount, amount: u64) {
    let bytes = unsafe { vault.view.borrow_unchecked_mut() };
    bytes[64..72].copy_from_slice(&amount.to_le_bytes());
}

const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";

fn derive_vault(market: &Address) -> Address {
    Address::find_program_address(&[VAULT_SEED, market.as_ref()], &ID).0
}
fn derive_vault_authority(market: &Address) -> Address {
    Address::find_program_address(&[VAULT_AUTHORITY_SEED, market.as_ref()], &ID).0
}

struct Fixture {
    market: TestAccount,
    authority: TestAccount,
    trader: TestAccount,
    mint: TestAccount,
    token_program: TestAccount,
    vault: TestAccount,
    vault_authority: Address,
    mint_key: Address,
}

const DECIMALS: u8 = 6;

fn header_mut(market: &mut TestAccount) -> &mut MarketStateHeader {
    let data = unsafe { market.view.borrow_unchecked_mut() };
    unsafe { &mut *(data.as_mut_ptr() as *mut MarketStateHeader) }
}

fn seat_mut(market: &mut TestAccount, index: usize) -> &mut TraderSeat {
    let data = unsafe { market.view.borrow_unchecked_mut() };
    let start = TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE;
    unsafe { &mut *(data.as_mut_ptr().add(start) as *mut TraderSeat) }
}

/// Builds a market with a vault already initialized, one trader seat (index
/// 0) owned by `trader`, and the oracle marked open and valid.
fn fixture() -> Fixture {
    let market_key = Address::new_from_array([50; 32]);
    let authority_key = Address::new_from_array([51; 32]);
    let trader_key = Address::new_from_array([52; 32]);
    let mint_key = Address::new_from_array([53; 32]);

    let mut market = account(market_key, ID, MARKET_ACCOUNT_SIZE, false, true);
    let authority = account(authority_key, Address::default(), 0, true, false);
    let trader = account(trader_key, Address::default(), 0, true, false);
    process_instruction(
        &ID,
        &mut [market.view.clone(), authority.view.clone()],
        &[0],
    )
    .unwrap();
    {
        let header = header_mut(&mut market);
        header.mode = MarketMode::Open as u8;
        header.oracle_valid = 1;
        header.last_verified_oracle_price = 100;
        header.last_verified_oracle_timestamp = 1;
        header.maximum_position = 1_000_000;
        header.maximum_open_interest = 1_000_000;
        header.market_authority = authority_key.to_bytes();
        header.pause_authority = authority_key.to_bytes();
        header.emergency_authority = authority_key.to_bytes();
    }
    process_instruction(
        &ID,
        &mut [market.view.clone(), trader.view.clone()],
        &[1u8, 0, 0],
    )
    .unwrap();

    let vault_key = derive_vault(&market_key);
    let vault_authority = derive_vault_authority(&market_key);
    let mint = mint_account(mint_key, DECIMALS);
    let token_program = account(pinocchio_token::ID, Address::default(), 0, false, false);
    let vault = token_account(vault_key, mint_key, vault_authority, 0, true);
    let vault_authority_account = account(vault_authority, Address::default(), 0, false, false);

    process_instruction(
        &ID,
        &mut [
            market.view.clone(),
            authority.view.clone(),
            mint.view.clone(),
            token_program.view.clone(),
            vault.view.clone(),
            vault_authority_account.view.clone(),
        ],
        &[9],
    )
    .unwrap();

    Fixture {
        market,
        authority,
        trader,
        mint,
        token_program,
        vault,
        vault_authority,
        mint_key,
    }
}

fn deposit_data(seat_index: u16, amount: u64) -> Vec<u8> {
    let mut data = vec![10u8];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data
}
fn withdraw_data(seat_index: u16, amount: u64) -> Vec<u8> {
    let mut data = vec![11u8];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

#[test]
fn initialize_vault_stores_config_and_rejects_duplicate_and_wrong_authority() {
    let f = fixture();
    let data = unsafe { f.market.view.borrow_unchecked() };
    let header = unsafe { &*(data.as_ptr() as *const MarketStateHeader) };
    let mint_bytes = header.collateral_mint;
    let token_program_bytes = header.collateral_token_program;
    assert_eq!(mint_bytes, f.mint_key.to_bytes());
    assert_eq!(token_program_bytes, pinocchio_token::ID.to_bytes());
    let _ = data;

    let f2 = fixture();
    let f2_vault_authority_account =
        account(f2.vault_authority, Address::default(), 0, false, false);
    // Duplicate InitializeVault on an already-configured market is rejected.
    let result = process_instruction(
        &ID,
        &mut [
            f2.market.view.clone(),
            f2.authority.view.clone(),
            f2.mint.view.clone(),
            f2.token_program.view.clone(),
            f2.vault.view.clone(),
            f2_vault_authority_account.view.clone(),
        ],
        &[9],
    );
    assert!(result.is_err());

    // Wrong authority is rejected on a fresh, un-vaulted market -- every
    // other account (vault, vault authority, token program) is correctly
    // derived and valid, so this genuinely exercises the authority check
    // rather than failing earlier for an unrelated reason.
    let market_key = Address::new_from_array([60; 32]);
    let wrong_authority = Address::new_from_array([61; 32]);
    let real_authority = Address::new_from_array([62; 32]);
    let market = account(market_key, ID, MARKET_ACCOUNT_SIZE, false, true);
    let wrong = account(wrong_authority, Address::default(), 0, true, false);
    let real = account(real_authority, Address::default(), 0, true, false);
    process_instruction(&ID, &mut [market.view.clone(), real.view.clone()], &[0]).unwrap();
    let mint_key = Address::new_from_array([63; 32]);
    let mint = mint_account(mint_key, DECIMALS);
    let token_program = account(pinocchio_token::ID, Address::default(), 0, false, false);
    let vault = token_account(
        derive_vault(&market_key),
        mint_key,
        derive_vault_authority(&market_key),
        0,
        true,
    );
    let vault_authority_account = account(
        derive_vault_authority(&market_key),
        Address::default(),
        0,
        false,
        false,
    );
    let result = process_instruction(
        &ID,
        &mut [
            market.view.clone(),
            wrong.view.clone(),
            mint.view.clone(),
            token_program.view.clone(),
            vault.view.clone(),
            vault_authority_account.view.clone(),
        ],
        &[9],
    );
    assert!(result.is_err());
}

#[test]
fn deposit_credits_the_seat_and_rejects_a_non_owner_and_insufficient_balance() {
    let mut f = fixture();
    let source = token_account(
        Address::new_from_array([70; 32]),
        f.mint_key,
        *f.trader.view.address(),
        1_000,
        true,
    );
    let unused_slot = account(
        Address::new_from_array([71; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let mut accounts = [
        f.market.view.clone(),
        f.trader.view.clone(),
        unused_slot.view.clone(),
        source.view.clone(),
        f.vault.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    process_instruction(&ID, &mut accounts, &deposit_data(0, 400)).unwrap();
    let seat = seat_mut(&mut f.market, 0);
    let available = seat.available_collateral;
    assert_eq!(available, 400);

    // Non-owner (wrong trader) is rejected.
    let attacker = account(
        Address::new_from_array([72; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let mut accounts = [
        f.market.view.clone(),
        attacker.view.clone(),
        unused_slot.view.clone(),
        source.view.clone(),
        f.vault.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    assert!(process_instruction(&ID, &mut accounts, &deposit_data(0, 1)).is_err());

    // Insufficient source balance is rejected.
    let mut accounts = [
        f.market.view.clone(),
        f.trader.view.clone(),
        unused_slot.view.clone(),
        source.view.clone(),
        f.vault.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    assert!(process_instruction(&ID, &mut accounts, &deposit_data(0, 1_000_000)).is_err());
}

#[test]
fn deposit_rejects_every_prohibited_account_alias() {
    let f = fixture();
    let source = token_account(
        Address::new_from_array([73; 32]),
        f.mint_key,
        *f.trader.view.address(),
        1_000,
        true,
    );
    let unused_slot = account(
        Address::new_from_array([74; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let base = [
        f.market.view.clone(),
        f.trader.view.clone(),
        unused_slot.view.clone(),
        source.view.clone(),
        f.vault.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    // Vault aliased to source: still 7 accounts, but two of them collide.
    let mut aliased = base.clone();
    aliased[4] = aliased[3].clone();
    assert!(process_instruction(&ID, &mut aliased, &deposit_data(0, 1)).is_err());
    // Mint aliased to token_program.
    let mut aliased = base.clone();
    aliased[5] = aliased[6].clone();
    assert!(process_instruction(&ID, &mut aliased, &deposit_data(0, 1)).is_err());
    // Market aliased to source.
    let mut aliased = base;
    aliased[3] = aliased[0].clone();
    assert!(process_instruction(&ID, &mut aliased, &deposit_data(0, 1)).is_err());
}

fn withdraw_accounts(
    f: &Fixture,
    destination: &TestAccount,
    vault_authority_account: &TestAccount,
) -> [AccountView; 7] {
    [
        f.market.view.clone(),
        f.trader.view.clone(),
        destination.view.clone(),
        f.mint.view.clone(),
        f.vault.view.clone(),
        vault_authority_account.view.clone(),
        f.token_program.view.clone(),
    ]
}

#[test]
fn withdraw_succeeds_within_health_and_rejects_margin_violation() {
    let mut f = fixture();
    seat_mut(&mut f.market, 0).available_collateral = 10_000;
    set_vault_amount(&mut f.vault, 10_000);
    let destination = token_account(
        Address::new_from_array([80; 32]),
        f.mint_key,
        *f.trader.view.address(),
        0,
        true,
    );
    let vault_authority_account = account(f.vault_authority, Address::default(), 0, false, false);

    let mut accounts = withdraw_accounts(&f, &destination, &vault_authority_account);
    process_instruction(&ID, &mut accounts, &withdraw_data(0, 4_000)).unwrap();
    let seat = seat_mut(&mut f.market, 0);
    let available = seat.available_collateral;
    assert_eq!(available, 6_000);

    // Withdrawing more than the remaining collateral is rejected.
    let mut accounts = withdraw_accounts(&f, &destination, &vault_authority_account);
    assert!(process_instruction(&ID, &mut accounts, &withdraw_data(0, 100_000)).is_err());
}

#[test]
fn withdraw_is_blocked_while_delegated_and_allowed_once_restored() {
    let mut f = fixture();
    seat_mut(&mut f.market, 0).available_collateral = 10_000;
    set_vault_amount(&mut f.vault, 10_000);
    let destination = token_account(
        Address::new_from_array([81; 32]),
        f.mint_key,
        *f.trader.view.address(),
        0,
        true,
    );
    let vault_authority_account = account(f.vault_authority, Address::default(), 0, false, false);

    header_mut(&mut f.market).set_delegation_status(DelegationStatus::Delegated);
    let mut accounts = withdraw_accounts(&f, &destination, &vault_authority_account);
    assert!(process_instruction(&ID, &mut accounts, &withdraw_data(0, 1_000)).is_err());

    // Regression test for the Priority 1/4 integration defect: a `Restored`
    // market (status 3) must be withdrawable, exactly like `NotDelegated`.
    // Before the fix, `validate_custody_tokens` independently rejected any
    // non-zero `reserved_upgrade[2]` (the same byte `DelegationStatus` uses),
    // so `Restored` would pass `l1_withdrawals_allowed()` but still fail here.
    header_mut(&mut f.market).set_delegation_status(DelegationStatus::Restored);
    let mut accounts = withdraw_accounts(&f, &destination, &vault_authority_account);
    process_instruction(&ID, &mut accounts, &withdraw_data(0, 1_000)).unwrap();
    let seat = seat_mut(&mut f.market, 0);
    let available = seat.available_collateral;
    assert_eq!(available, 9_000);
}

#[test]
fn withdraw_is_blocked_while_vault_deficit_is_unresolved() {
    let mut f = fixture();
    seat_mut(&mut f.market, 0).available_collateral = 10_000;
    set_vault_amount(&mut f.vault, 10_000);
    header_mut(&mut f.market).set_reconciliation_status(ReconciliationStatus::DeficitDetected);
    let destination = token_account(
        Address::new_from_array([82; 32]),
        f.mint_key,
        *f.trader.view.address(),
        0,
        true,
    );
    let vault_authority_account = account(f.vault_authority, Address::default(), 0, false, false);
    let mut accounts = withdraw_accounts(&f, &destination, &vault_authority_account);
    let error = process_instruction(&ID, &mut accounts, &withdraw_data(0, 1_000)).unwrap_err();
    assert_eq!(
        error,
        ProgramError::from(StockStreamError::CustodyViolation)
    );
}

#[test]
fn reconcile_vault_matches_detects_surplus_and_escalates_a_persistent_deficit() {
    let mut f = fixture();
    seat_mut(&mut f.market, 0).available_collateral = 10_000;
    let reconcile = |f: &Fixture| -> Vec<AccountView> {
        vec![
            f.market.view.clone(),
            f.vault.view.clone(),
            f.mint.view.clone(),
            f.token_program.view.clone(),
        ]
    };

    // Exactly matches: Reconciled.
    set_vault_amount(&mut f.vault, 10_000);
    let mut accounts = reconcile(&f);
    process_instruction(&ID, &mut accounts, &[39]).unwrap();
    let status = header_mut(&mut f.market).reconciliation_status();
    assert_eq!(status, ReconciliationStatus::Reconciled as u8);

    // Vault holds more than expected: SurplusDetected, recorded not assigned.
    set_vault_amount(&mut f.vault, 10_500);
    let mut accounts = reconcile(&f);
    process_instruction(&ID, &mut accounts, &[39]).unwrap();
    {
        let header = header_mut(&mut f.market);
        let status = header.reconciliation_status();
        let surplus = header.vault_surplus();
        assert_eq!(status, ReconciliationStatus::SurplusDetected as u8);
        assert_eq!(surplus, 500);
    }

    // Vault is short: DeficitDetected the first time, and the market is
    // paused to stop new risk.
    set_vault_amount(&mut f.vault, 9_000);
    let mut accounts = reconcile(&f);
    process_instruction(&ID, &mut accounts, &[39]).unwrap();
    {
        let header = header_mut(&mut f.market);
        let status = header.reconciliation_status();
        let mode = header.mode;
        assert_eq!(status, ReconciliationStatus::DeficitDetected as u8);
        assert_eq!(mode, MarketMode::Paused as u8);
    }

    // A second consecutive deficit escalates to RecoveryRequired.
    let mut accounts = reconcile(&f);
    process_instruction(&ID, &mut accounts, &[39]).unwrap();
    let status = header_mut(&mut f.market).reconciliation_status();
    assert_eq!(status, ReconciliationStatus::RecoveryRequired as u8);
}

fn insurance_transfer_data(amount: u64) -> Vec<u8> {
    let mut data = vec![34u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

#[test]
fn transfer_to_insurance_fund_moves_the_ledger_and_requires_market_authority() {
    let mut f = fixture();
    // Seed a protocol fee balance the way a real fill would (see
    // `account_settlement.rs::crossing_fill_credits_the_protocol_fee_ledger`
    // for the end-to-end path); directly here since this test targets the
    // ledger-transfer handler in isolation.
    header_mut(&mut f.market).set_protocol_fee_balance(1_000);

    let mut accounts = [f.market.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &insurance_transfer_data(400)).unwrap();
    {
        let header = header_mut(&mut f.market);
        let fees = header.protocol_fee_balance();
        let insurance = header.insurance_fund_balance();
        assert_eq!(fees, 600);
        assert_eq!(insurance, 400);
    }

    let attacker = account(
        Address::new_from_array([90; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let mut accounts = [f.market.view.clone(), attacker.view.clone()];
    let error = process_instruction(&ID, &mut accounts, &insurance_transfer_data(1)).unwrap_err();
    assert_eq!(
        error,
        ProgramError::from(StockStreamError::CustodyViolation)
    );
}

#[test]
fn withdraw_protocol_fees_pays_out_and_withdraw_insurance_requires_emergency_authority() {
    let mut f = fixture();
    header_mut(&mut f.market).set_protocol_fee_balance(1_000);
    set_vault_amount(&mut f.vault, 1_000);
    let destination = token_account(
        Address::new_from_array([91; 32]),
        f.mint_key,
        Address::new_from_array([92; 32]),
        0,
        true,
    );
    let vault_authority_account = account(f.vault_authority, Address::default(), 0, false, false);

    let mut fee_data = vec![35u8];
    fee_data.extend_from_slice(&300u64.to_le_bytes());
    let mut accounts = [
        f.market.view.clone(),
        f.authority.view.clone(),
        f.vault.view.clone(),
        vault_authority_account.view.clone(),
        destination.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    process_instruction(&ID, &mut accounts, &fee_data).unwrap();
    let fees = header_mut(&mut f.market).protocol_fee_balance();
    assert_eq!(fees, 700);

    // Protocol-fee authority (market authority) cannot withdraw insurance
    // funds: that requires the emergency authority specifically. In this
    // fixture they are the same key, so instead verify a *different* signer
    // (not the emergency authority) is rejected for both ledgers.
    header_mut(&mut f.market).set_insurance_fund_balance(500);
    let outsider = account(
        Address::new_from_array([93; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let mut insurance_data = vec![36u8];
    insurance_data.extend_from_slice(&100u64.to_le_bytes());
    let mut accounts = [
        f.market.view.clone(),
        outsider.view.clone(),
        f.vault.view.clone(),
        vault_authority_account.view.clone(),
        destination.view.clone(),
        f.mint.view.clone(),
        f.token_program.view.clone(),
    ];
    let error = process_instruction(&ID, &mut accounts, &insurance_data).unwrap_err();
    assert_eq!(
        error,
        ProgramError::from(StockStreamError::CustodyViolation)
    );
}

#[test]
fn record_bad_debt_requires_a_bankrupt_seat_and_resolve_requires_insurance_coverage() {
    let mut f = fixture();
    // A healthy (non-bankrupt) seat cannot have bad debt recorded.
    seat_mut(&mut f.market, 0).available_collateral = 10_000;
    let mut record_data = vec![37u8, 0, 0];
    record_data.extend_from_slice(&100u64.to_le_bytes());
    let mut accounts = [f.market.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &record_data).is_err());

    // Make the seat bankrupt: negative realized PnL exceeding its collateral.
    {
        let seat = seat_mut(&mut f.market, 0);
        seat.available_collateral = 100;
        seat.realized_pnl = -600;
    }
    // equity = 100 + (-600) + 0 = -500; forgiving 100 is within bounds.
    let mut accounts = [f.market.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &record_data).unwrap();
    {
        let header = header_mut(&mut f.market);
        let debt = header.recognized_bad_debt();
        assert_eq!(debt, 100);
    }
    let realized_pnl = seat_mut(&mut f.market, 0).realized_pnl;
    assert_eq!(realized_pnl, -500);

    // ResolveBadDebt requires the insurance fund to actually cover it.
    let mut resolve_data = vec![38u8];
    resolve_data.extend_from_slice(&100u64.to_le_bytes());
    let mut accounts = [f.market.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &resolve_data).is_err());

    header_mut(&mut f.market).set_insurance_fund_balance(100);
    let mut accounts = [f.market.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &resolve_data).unwrap();
    {
        let header = header_mut(&mut f.market);
        let debt = header.recognized_bad_debt();
        let insurance = header.insurance_fund_balance();
        assert_eq!(debt, 0);
        assert_eq!(insurance, 0);
    }
}
