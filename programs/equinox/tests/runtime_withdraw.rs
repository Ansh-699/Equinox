#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for the Equinox **withdrawal**, **reconciliation**
//! and market-level **ledger** paths, driven against the deployed
//! `equinox.so` inside LiteSVM (which installs the canonical SPL Token
//! program). Unlike `tests/custody.rs`, the vault-authority-signed
//! `Transfer` CPI really executes here.
//!
//! ABI under test (all mirrored by `clients/equinox/src/index.ts`):
//!
//!   * `WithdrawCollateral` [11, seat:u16@1, amount:u64@3]:
//!     `[market (w), authority (signer), destination (w), mint, vault (w), vault_authority, token_program]`;
//!   * `TransferToInsuranceFund` [34, amount:u64@1]: `[market (w), market_authority (signer)]`;
//!   * `WithdrawProtocolFees` [35, amount:u64@1] / `WithdrawInsuranceFunds` [36, amount:u64@1]:
//!     `[market (w), authority (signer), vault (w), vault_authority, destination (w), mint, token_program]`;
//!   * `RecordBadDebt` [37, seat:u16@1, amount:u64@3]: `[market (w), emergency_authority (signer)]`;
//!   * `ResolveBadDebt` [38, amount:u64@1]: `[market (w), emergency_authority (signer)]`;
//!   * `ReconcileVault` [39]: `[market, vault, mint, token_program]` (permissionless).

use std::path::PathBuf;
use std::ptr;

use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::{
    instruction as token_ix,
    state::{Account as TokenAccount, Mint},
    ID as TOKENKEG,
};
use equinox::{
    instruction::{
        DEPOSIT_COLLATERAL, RECONCILE_VAULT, RECORD_BAD_DEBT, RESOLVE_BAD_DEBT,
        TRANSFER_TO_INSURANCE_FUND, WITHDRAW_COLLATERAL, WITHDRAW_INSURANCE_FUNDS,
        WITHDRAW_PROTOCOL_FEES,
    },
    state::{
        DelegationStatus, MarketMode, MarketStateHeader, ReconciliationStatus, TraderSeat,
        MARKET_ACCOUNT_SIZE, TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE,
    },
    ID,
};

const DECIMALS: u8 = 6;
const SOURCE_FUNDING: u64 = 20_000;

const COLLATERAL_WITHDRAWN: u16 = 402;
const PROTOCOL_FEES_CHANGED: u16 = 403;
const INSURANCE_FUND_CHANGED: u16 = 404;
const BAD_DEBT_RECORDED: u16 = 405;
const BAD_DEBT_RESOLVED: u16 = 406;
const VAULT_SURPLUS_DETECTED: u16 = 407;
const VAULT_DEFICIT_DETECTED: u16 = 408;
const VAULT_RECONCILED: u16 = 409;

fn program_path() -> PathBuf {
    std::env::var_os("EQUINOX_TEST_SBF")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/equinox.so")
        })
}

fn derive_vault(market: &Address) -> Address {
    Address::find_program_address(&[b"vault", market.as_ref()], &ID).0
}

fn derive_vault_authority(market: &Address) -> Address {
    Address::find_program_address(&[b"vault-authority", market.as_ref()], &ID).0
}

struct Env {
    svm: LiteSVM,
    authority: Keypair,
    trader: Keypair,
    market: Address,
    mint: Address,
    source: Address,
    vault: Address,
    vault_authority: Address,
}

fn install(svm: &mut LiteSVM, address: Address, data: Vec<u8>, owner: Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<TransactionMetadata, String> {
    // Rotate the blockhash so repeated identical instructions stay distinct:
    // LiteSVM rejects a re-sent transaction by signature.
    svm.expire_blockhash();
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new(&signers, message, blockhash);
    svm.send_transaction(transaction)
        .map_err(|failed| format!("{:?} | {}", failed.err, failed.meta.pretty_logs()))
}

fn equinox_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: ID,
        accounts,
        data,
    }
}

fn market_data(svm: &LiteSVM, market: Address) -> Vec<u8> {
    svm.get_account(&market).unwrap().data
}

fn write_market_data(svm: &mut LiteSVM, market: Address, data: Vec<u8>) {
    let mut account = svm.get_account(&market).unwrap();
    account.data = data;
    svm.set_account(market, account).unwrap();
}

fn header(svm: &LiteSVM, market: Address) -> MarketStateHeader {
    unsafe { ptr::read_unaligned(market_data(svm, market).as_ptr() as *const MarketStateHeader) }
}

fn write_header(svm: &mut LiteSVM, market: Address, head: MarketStateHeader) {
    let mut data = market_data(svm, market);
    unsafe { ptr::write_unaligned(data.as_mut_ptr() as *mut MarketStateHeader, head) };
    write_market_data(svm, market, data);
}

fn seat(svm: &LiteSVM, market: Address, index: usize) -> TraderSeat {
    let data = market_data(svm, market);
    unsafe {
        ptr::read_unaligned(
            data.as_ptr()
                .add(TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE)
                as *const TraderSeat,
        )
    }
}

fn write_seat(svm: &mut LiteSVM, market: Address, index: usize, seat: TraderSeat) {
    let at = TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE;
    let mut data = market_data(svm, market);
    unsafe { ptr::write_unaligned(data.as_mut_ptr().add(at) as *mut TraderSeat, seat) };
    write_market_data(svm, market, data);
}

fn seat_collateral(svm: &LiteSVM, market: Address, index: usize) -> i128 {
    let seat = seat(svm, market, index);
    seat.available_collateral
}

fn header_mode(svm: &LiteSVM, market: Address) -> u8 {
    let head = header(svm, market);
    head.mode
}

fn token_data(svm: &LiteSVM, address: Address) -> Vec<u8> {
    svm.get_account(&address).unwrap().data
}

fn token_amount(svm: &LiteSVM, address: Address) -> u64 {
    TokenAccount::unpack(&token_data(svm, address))
        .unwrap()
        .amount
}

fn total_trader_collateral(svm: &LiteSVM, market: Address) -> i128 {
    let mut total = 0i128;
    for index in 0..128 {
        total += seat(svm, market, index).available_collateral;
    }
    total
}

/// Full custody environment, identical to `runtime_deposit.rs`'s.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("the deployed artifact must load in LiteSVM");

    let authority = Keypair::new();
    let trader = Keypair::new();
    svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&trader.pubkey(), 1_000_000_000).unwrap();

    let market = Address::new_unique();
    install(&mut svm, market, vec![0; MARKET_ACCOUNT_SIZE], ID);

    send(
        &mut svm,
        &authority,
        equinox_ix(
            vec![0],
            vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
            ],
        ),
        &[],
    )
    .expect("InitializeMarket");

    {
        let authority_bytes = authority.pubkey().to_bytes();
        let mut head = header(&svm, market);
        head.mode = MarketMode::Open as u8;
        head.oracle_valid = 1;
        head.last_verified_oracle_price = 100;
        head.last_verified_oracle_timestamp = 1;
        head.maximum_position = 1_000_000;
        head.maximum_open_interest = 1_000_000;
        head.market_authority = authority_bytes;
        head.pause_authority = authority_bytes;
        head.emergency_authority = authority_bytes;
        write_header(&mut svm, market, head);
    }

    send(
        &mut svm,
        &authority,
        equinox_ix(
            vec![1, 0, 0],
            vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(trader.pubkey(), true),
            ],
        ),
        &[&trader],
    )
    .expect("CreateTraderSeat");

    let mint = Address::new_unique();
    let source = Address::new_unique();
    let vault = derive_vault(&market);
    let vault_authority = derive_vault_authority(&market);

    install(&mut svm, mint, vec![0; Mint::LEN], TOKENKEG);
    install(&mut svm, source, vec![0; TokenAccount::LEN], TOKENKEG);
    install(&mut svm, vault, vec![0; TokenAccount::LEN], TOKENKEG);

    let init_mint =
        token_ix::initialize_mint2(&TOKENKEG, &mint, &authority.pubkey(), None, DECIMALS).unwrap();
    send(&mut svm, &authority, init_mint, &[]).expect("InitializeMint2");
    let init_source =
        token_ix::initialize_account3(&TOKENKEG, &source, &mint, &trader.pubkey()).unwrap();
    send(&mut svm, &authority, init_source, &[]).expect("InitializeAccount3 source");
    let init_vault =
        token_ix::initialize_account3(&TOKENKEG, &vault, &mint, &vault_authority).unwrap();
    send(&mut svm, &authority, init_vault, &[]).expect("InitializeAccount3 vault");
    let mint_to = token_ix::mint_to(
        &TOKENKEG,
        &mint,
        &source,
        &authority.pubkey(),
        &[],
        SOURCE_FUNDING,
    )
    .unwrap();
    send(&mut svm, &authority, mint_to, &[]).expect("MintTo source");

    send(
        &mut svm,
        &authority,
        equinox_ix(
            vec![9],
            vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(TOKENKEG, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(vault_authority, false),
            ],
        ),
        &[],
    )
    .expect("InitializeVault");

    Env {
        svm,
        authority,
        trader,
        market,
        mint,
        source,
        vault,
        vault_authority,
    }
}

fn deposit(env: &mut Env, amount: u64) -> Result<(), String> {
    let mut data = vec![DEPOSIT_COLLATERAL];
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    let instruction = equinox_ix(
        data,
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.trader.pubkey(), true),
            AccountMeta::new(env.source, false),
            AccountMeta::new(env.vault, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(TOKENKEG, false),
        ],
    );
    send(&mut env.svm, &env.authority, instruction, &[&env.trader]).map(|_| ())
}

fn withdraw_data(amount: u64) -> Vec<u8> {
    let mut data = vec![WITHDRAW_COLLATERAL];
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

#[allow(clippy::too_many_arguments)]
fn withdraw_ix(
    market: Address,
    authority: Address,
    destination: Address,
    mint: Address,
    vault: Address,
    vault_authority: Address,
    token_program: Address,
    amount: u64,
) -> Instruction {
    equinox_ix(
        withdraw_data(amount),
        vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(vault_authority, false),
            AccountMeta::new_readonly(token_program, false),
        ],
    )
}

fn standard_withdraw(env: &Env, destination: Address, amount: u64) -> Instruction {
    withdraw_ix(
        env.market,
        env.trader.pubkey(),
        destination,
        env.mint,
        env.vault,
        env.vault_authority,
        TOKENKEG,
        amount,
    )
}

/// Builds and submits the canonical withdrawal for a seat owned by the trader.
fn withdraw(
    env: &mut Env,
    destination: Address,
    amount: u64,
) -> Result<TransactionMetadata, String> {
    let instruction = standard_withdraw(env, destination, amount);
    send(&mut env.svm, &env.authority, instruction, &[&env.trader])
}

/// Submits an already-built (possibly malformed) withdrawal instruction.
fn withdraw_and_send(
    env: &mut Env,
    instruction: Instruction,
) -> Result<TransactionMetadata, String> {
    send(&mut env.svm, &env.authority, instruction, &[&env.trader])
}

/// A destination token account owned by `trader`.
fn new_trader_account(env: &mut Env) -> Address {
    let address = Address::new_unique();
    install(&mut env.svm, address, vec![0; TokenAccount::LEN], TOKENKEG);
    let init = token_ix::initialize_account3(&TOKENKEG, &address, &env.mint, &env.trader.pubkey())
        .unwrap();
    send(&mut env.svm, &env.authority, init, &[]).unwrap();
    address
}

fn reconcile_ix(env: &Env) -> Instruction {
    equinox_ix(
        vec![RECONCILE_VAULT],
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.vault, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(TOKENKEG, false),
        ],
    )
}

fn reconcile(env: &mut Env) -> Result<TransactionMetadata, String> {
    let instruction = reconcile_ix(env);
    send(&mut env.svm, &env.authority, instruction, &[])
}

// ---------------------------------------------------------------------------
// Event decoding.
// ---------------------------------------------------------------------------

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|&c| c == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

fn find_event(logs: &[String], kind: u16) -> Vec<u8> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: ").and_then(decode_base64))
        .find(|record| record.len() == 100 && u16::from_le_bytes([record[0], record[1]]) == kind)
        .unwrap_or_else(|| panic!("expected a program-data event with kind {kind}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn withdrawal_is_signed_by_the_vault_authority_and_moves_tokens() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");
    let destination = new_trader_account(&mut env);

    let seat_before = seat_collateral(&env.svm, env.market, 0);
    let vault_before = token_amount(&env.svm, env.vault);
    let sequence_before = {
        let head = header(&env.svm, env.market);
        head.global_event_sequence
    };

    let metadata =
        withdraw(&mut env, destination, 4_000).expect("WithdrawCollateral via vault-authority CPI");
    assert!(metadata.compute_units_consumed > 0);

    assert_eq!(
        seat_collateral(&env.svm, env.market, 0),
        seat_before - 4_000
    );
    assert_eq!(token_amount(&env.svm, env.vault), vault_before - 4_000);
    assert_eq!(token_amount(&env.svm, destination), 4_000);

    // The vault remains exactly backed by the market liability after payout.
    let liability = {
        let head = header(&env.svm, env.market);
        total_trader_collateral(&env.svm, env.market)
            + i128::from(head.protocol_fee_balance())
            + i128::from(head.insurance_fund_balance())
            - i128::from(head.recognized_bad_debt())
    };
    assert_eq!(i128::from(token_amount(&env.svm, env.vault)), liability);

    let sequence_after = {
        let head = header(&env.svm, env.market);
        head.global_event_sequence
    };
    assert_eq!(sequence_after, sequence_before + 1);
    let event = find_event(&metadata.logs, COLLATERAL_WITHDRAWN);
    assert_eq!(
        u64::from_le_bytes(event[4..12].try_into().unwrap()),
        sequence_after
    );
    assert_eq!(u64::from_le_bytes(event[54..62].try_into().unwrap()), 4_000);
    assert_eq!(
        u64::from_le_bytes(event[62..70].try_into().unwrap()),
        vault_before - 4_000,
        "event reports the resulting vault balance"
    );
}

#[test]
fn withdrawal_respects_reserved_margin() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");

    // Pin a reserved margin of 5_000: withdrawing 6_000 would leave 4_000 below
    // the reservation, so it must be refused; withdrawing 5_000 leaves exactly
    // the reservation and is allowed.
    let mut seat = seat(&env.svm, env.market, 0);
    seat.reserved_margin = 5_000;
    write_seat(&mut env.svm, env.market, 0, seat);

    let market_before = market_data(&env.svm, env.market);
    let vault_before = token_data(&env.svm, env.vault);
    let destination = new_trader_account(&mut env);

    let over = standard_withdraw(&env, destination, 6_000);
    assert!(
        withdraw_and_send(&mut env, over).is_err(),
        "a withdrawal that breaches the reserved margin must be rejected"
    );
    assert_eq!(market_data(&env.svm, env.market), market_before);
    assert_eq!(token_data(&env.svm, env.vault), vault_before);

    withdraw(&mut env, destination, 5_000)
        .expect("a withdrawal leaving exactly the reserved margin is allowed");
    assert_eq!(seat_collateral(&env.svm, env.market, 0), 5_000);
    assert_eq!(token_amount(&env.svm, destination), 5_000);
}

#[test]
fn withdrawal_rejects_wrong_destination_mint_vault_and_authority() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");
    let destination = new_trader_account(&mut env);
    let market_before = market_data(&env.svm, env.market);
    let vault_before = token_data(&env.svm, env.vault);

    // Wrong destination (a token account the trader does not own).
    let foreign = Address::new_unique();
    install(&mut env.svm, foreign, vec![0; TokenAccount::LEN], TOKENKEG);
    let init =
        token_ix::initialize_account3(&TOKENKEG, &foreign, &env.mint, &Address::new_unique())
            .unwrap();
    send(&mut env.svm, &env.authority, init, &[]).unwrap();
    let wrong_destination = withdraw_ix(
        env.market,
        env.trader.pubkey(),
        foreign,
        env.mint,
        env.vault,
        env.vault_authority,
        TOKENKEG,
        1_000,
    );
    assert!(withdraw_and_send(&mut env, wrong_destination).is_err());

    // Wrong vault.
    let wrong_vault = withdraw_ix(
        env.market,
        env.trader.pubkey(),
        destination,
        env.mint,
        Address::new_unique(),
        env.vault_authority,
        TOKENKEG,
        1_000,
    );
    assert!(withdraw_and_send(&mut env, wrong_vault).is_err());

    // Wrong vault authority.
    let wrong_authority = withdraw_ix(
        env.market,
        env.trader.pubkey(),
        destination,
        env.mint,
        env.vault,
        Address::new_unique(),
        TOKENKEG,
        1_000,
    );
    assert!(withdraw_and_send(&mut env, wrong_authority).is_err());

    // Wrong mint.
    let wrong_mint = withdraw_ix(
        env.market,
        env.trader.pubkey(),
        destination,
        Address::new_unique(),
        env.vault,
        env.vault_authority,
        TOKENKEG,
        1_000,
    );
    assert!(withdraw_and_send(&mut env, wrong_mint).is_err());

    assert_eq!(market_data(&env.svm, env.market), market_before);
    assert_eq!(token_data(&env.svm, env.vault), vault_before);
    assert_eq!(token_amount(&env.svm, destination), 0);
}

#[test]
fn withdrawal_rejects_a_non_owner_and_rolls_back_on_cpi_failure() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");
    let destination = new_trader_account(&mut env);
    let market_before = market_data(&env.svm, env.market);
    let vault_before = token_data(&env.svm, env.vault);

    // A signer that is not the seat owner.
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let non_owner = withdraw_ix(
        env.market,
        attacker.pubkey(),
        destination,
        env.mint,
        env.vault,
        env.vault_authority,
        TOKENKEG,
        1_000,
    );
    assert!(
        send(&mut env.svm, &env.authority, non_owner, &[&attacker]).is_err(),
        "a non-owner must not withdraw"
    );

    // Freeze the vault: the Equinox pre-checks pass, the vault-authority
    // Transfer CPI fails, and the runtime rolls back the seat mutation.
    let mut vault = token_data(&env.svm, env.vault);
    vault[108] = 2; // Frozen
    {
        let mut account = env.svm.get_account(&env.vault).unwrap();
        account.data = vault;
        env.svm.set_account(env.vault, account).unwrap();
    }
    let vault_frozen = token_data(&env.svm, env.vault);
    let seat_before = seat_collateral(&env.svm, env.market, 0);
    let frozen_result = withdraw(&mut env, destination, 1_000);
    assert!(frozen_result.is_err(), "a Tokenkeg CPI failure must abort");

    assert_eq!(
        seat_collateral(&env.svm, env.market, 0),
        seat_before,
        "the seat debit must be rolled back"
    );
    assert_eq!(token_data(&env.svm, env.vault), vault_frozen);
    let _ = (market_before, vault_before);
    assert_eq!(token_amount(&env.svm, destination), 0);
}

#[test]
fn l1_custody_is_blocked_while_delegated_and_permitted_once_restored() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");
    let destination = new_trader_account(&mut env);

    // Delegated: L1 deposits and withdrawals are refused.
    let mut head = header(&env.svm, env.market);
    head.set_delegation_status(DelegationStatus::Delegated);
    write_header(&mut env.svm, env.market, head);

    let market_before = market_data(&env.svm, env.market);
    assert!(
        deposit(&mut env, 1).is_err(),
        "deposit blocked while delegated"
    );
    assert!(
        withdraw(&mut env, destination, 1).is_err(),
        "withdrawal blocked while delegated"
    );
    assert_eq!(market_data(&env.svm, env.market), market_before);

    // Restored: L1 custody is permitted again.
    let mut head = header(&env.svm, env.market);
    head.set_delegation_status(DelegationStatus::Restored);
    write_header(&mut env.svm, env.market, head);
    withdraw(&mut env, destination, 1_000).expect("withdrawal permitted once restored");
    assert_eq!(token_amount(&env.svm, destination), 1_000);
}

#[test]
fn reconcile_detects_reconciled_surplus_and_deficit_then_recovery() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");

    // Exact backing -> Reconciled.
    let metadata = reconcile(&mut env).expect("ReconcileVault");
    let head = header(&env.svm, env.market);
    assert_eq!(
        head.reconciliation_status(),
        ReconciliationStatus::Reconciled as u8
    );
    assert!(head.vault_surplus() == 0);
    find_event(&metadata.logs, VAULT_RECONCILED);

    // Surplus: extra tokens in the vault beyond the liability.
    let mint_to = token_ix::mint_to(
        &TOKENKEG,
        &env.mint,
        &env.vault,
        &env.authority.pubkey(),
        &[],
        500,
    )
    .unwrap();
    send(&mut env.svm, &env.authority, mint_to, &[]).unwrap();
    let metadata = reconcile(&mut env).expect("ReconcileVault surplus");
    let head = header(&env.svm, env.market);
    assert_eq!(
        head.reconciliation_status(),
        ReconciliationStatus::SurplusDetected as u8
    );
    assert_eq!(head.vault_surplus(), 500);
    find_event(&metadata.logs, VAULT_SURPLUS_DETECTED);

    // Deficit: drain the vault below the liability. Withdrawals must be blocked.
    {
        let mut vault = token_data(&env.svm, env.vault);
        vault[64..72].copy_from_slice(&9_000u64.to_le_bytes());
        let mut account = env.svm.get_account(&env.vault).unwrap();
        account.data = vault;
        env.svm.set_account(env.vault, account).unwrap();
    }
    let metadata = reconcile(&mut env).expect("ReconcileVault deficit");
    let head = header(&env.svm, env.market);
    assert_eq!(
        head.reconciliation_status(),
        ReconciliationStatus::DeficitDetected as u8
    );
    assert_eq!(header_mode(&env.svm, env.market), MarketMode::Paused as u8);
    find_event(&metadata.logs, VAULT_DEFICIT_DETECTED);

    let destination = new_trader_account(&mut env);
    assert!(
        withdraw(&mut env, destination, 1).is_err(),
        "withdrawals must be blocked while a deficit is unresolved"
    );

    // Recovery: restore the vault and reconcile again -> Reconciled, withdrawals allowed.
    {
        let mut vault = token_data(&env.svm, env.vault);
        vault[64..72].copy_from_slice(&10_000u64.to_le_bytes());
        let mut account = env.svm.get_account(&env.vault).unwrap();
        account.data = vault;
        env.svm.set_account(env.vault, account).unwrap();
    }
    let metadata = reconcile(&mut env).expect("ReconcileVault recovery");
    find_event(&metadata.logs, VAULT_RECONCILED);
    withdraw(&mut env, destination, 1_000).expect("withdrawal permitted after recovery");
    assert_eq!(token_amount(&env.svm, destination), 1_000);
}

#[test]
fn protocol_fee_and_insurance_ledgers_move_through_the_vault() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");

    // Seed a protocol-fee ledger balance (normally accrued by trading).
    {
        let mut head = header(&env.svm, env.market);
        head.set_protocol_fee_balance(1_000);
        write_header(&mut env.svm, env.market, head);
    }

    // Protocol fees -> insurance fund (internal ledger move, no CPI).
    let transfer = equinox_ix(
        vec![TRANSFER_TO_INSURANCE_FUND]
            .into_iter()
            .chain(500u64.to_le_bytes())
            .collect(),
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.authority.pubkey(), true),
        ],
    );
    let metadata =
        send(&mut env.svm, &env.authority, transfer, &[]).expect("TransferToInsuranceFund");
    let head = header(&env.svm, env.market);
    assert_eq!(head.protocol_fee_balance(), 500);
    assert_eq!(head.insurance_fund_balance(), 500);
    let event = find_event(&metadata.logs, INSURANCE_FUND_CHANGED);
    assert_eq!(u64::from_le_bytes(event[54..62].try_into().unwrap()), 500);

    // Withdraw the remaining protocol fees to an external account via CPI.
    let destination = new_trader_account(&mut env);
    let vault_before = token_amount(&env.svm, env.vault);
    let withdraw_fees = equinox_ix(
        vec![WITHDRAW_PROTOCOL_FEES]
            .into_iter()
            .chain(500u64.to_le_bytes())
            .collect(),
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.authority.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new_readonly(env.vault_authority, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(TOKENKEG, false),
        ],
    );
    let metadata =
        send(&mut env.svm, &env.authority, withdraw_fees, &[]).expect("WithdrawProtocolFees");
    let head = header(&env.svm, env.market);
    assert_eq!(head.protocol_fee_balance(), 0);
    assert_eq!(token_amount(&env.svm, env.vault), vault_before - 500);
    assert_eq!(token_amount(&env.svm, destination), 500);
    find_event(&metadata.logs, PROTOCOL_FEES_CHANGED);

    // Withdraw the insurance funds (emergency authority == market authority here).
    let destination2 = new_trader_account(&mut env);
    let withdraw_insurance = equinox_ix(
        vec![WITHDRAW_INSURANCE_FUNDS]
            .into_iter()
            .chain(500u64.to_le_bytes())
            .collect(),
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.authority.pubkey(), true),
            AccountMeta::new(env.vault, false),
            AccountMeta::new_readonly(env.vault_authority, false),
            AccountMeta::new(destination2, false),
            AccountMeta::new_readonly(env.mint, false),
            AccountMeta::new_readonly(TOKENKEG, false),
        ],
    );
    send(&mut env.svm, &env.authority, withdraw_insurance, &[]).expect("WithdrawInsuranceFunds");
    let head = header(&env.svm, env.market);
    assert_eq!(head.insurance_fund_balance(), 0);
    assert_eq!(token_amount(&env.svm, destination2), 500);
}

#[test]
fn bad_debt_is_recorded_and_resolved_from_the_insurance_fund() {
    let mut env = setup();
    deposit(&mut env, 10_000).expect("seed deposit");

    // Make seat 0 insolvent at the mark price: equity = available + realized + unrealized < 0.
    let mut seat = seat(&env.svm, env.market, 0);
    seat.realized_pnl = -12_000;
    write_seat(&mut env.svm, env.market, 0, seat);

    let record = equinox_ix(
        {
            let mut data = vec![RECORD_BAD_DEBT];
            data.extend_from_slice(&0u16.to_le_bytes());
            data.extend_from_slice(&1_000u64.to_le_bytes());
            data
        },
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.authority.pubkey(), true),
        ],
    );
    let metadata = send(&mut env.svm, &env.authority, record, &[]).expect("RecordBadDebt");
    let head = header(&env.svm, env.market);
    assert_eq!(head.recognized_bad_debt(), 1_000);
    find_event(&metadata.logs, BAD_DEBT_RECORDED);

    // Fund the insurance ledger, then resolve the recognized debt against it.
    {
        let mut head = header(&env.svm, env.market);
        head.set_insurance_fund_balance(1_000);
        write_header(&mut env.svm, env.market, head);
    }
    let resolve = equinox_ix(
        vec![RESOLVE_BAD_DEBT]
            .into_iter()
            .chain(1_000u64.to_le_bytes())
            .collect(),
        vec![
            AccountMeta::new(env.market, false),
            AccountMeta::new_readonly(env.authority.pubkey(), true),
        ],
    );
    let metadata = send(&mut env.svm, &env.authority, resolve, &[]).expect("ResolveBadDebt");
    let head = header(&env.svm, env.market);
    assert_eq!(head.recognized_bad_debt(), 0);
    assert_eq!(head.insurance_fund_balance(), 0);
    find_event(&metadata.logs, BAD_DEBT_RESOLVED);
}
