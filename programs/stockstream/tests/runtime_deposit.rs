#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for the StockStream collateral **deposit** path.
//!
//! Unlike `tests/custody.rs` (which substitutes `invoke_with_program` with a
//! no-op off the SBF target), these drive the actual deployed
//! `stockstream.so` inside LiteSVM, where LiteSVM has already installed the
//! canonical SPL Token program ("Tokenkeg"). `DepositCollateral` therefore
//! performs a *real* `Transfer` CPI: source token account -> market vault,
//! signed by the trader.
//!
//! Custody ABI under test (mirrored byte-for-byte by
//! `clients/stockstream/src/index.ts`):
//!
//!   * `InitializeVault` [9]: accounts
//!     `[market (w), authority (signer), mint, token_program, vault (w), vault_authority]`;
//!   * `DepositCollateral` [10, seat:u16@1, amount:u64@3]: accounts
//!     `[market (w), authority (signer), seat-slot (w), source (w), vault (w), mint, token_program]`.
//!
//! Vault/authority are PDAs: `["vault", market]` and `["vault-authority", market]`.

use std::path::PathBuf;
use std::ptr;

use litesvm::LiteSVM;
use litesvm::types::TransactionMetadata;
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
use stockstream::{
    instruction::DEPOSIT_COLLATERAL,
    state::{
        MarketMode, MarketStateHeader, TraderSeat, MARKET_ACCOUNT_SIZE, TRADER_SEAT_OFFSET,
        TRADER_SEAT_SIZE,
    },
    ID,
};

const DECIMALS: u8 = 6;
const SOURCE_FUNDING: u64 = 10_000;
const DEPOSIT_AMOUNT: u64 = 400;
/// `events::EventKind::CollateralDeposited`.
const COLLATERAL_DEPOSITED: u16 = 401;

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn derive_vault(market: &Address) -> Address {
    Address::find_program_address(&[b"vault", market.as_ref()], &ID).0
}

fn derive_vault_authority(market: &Address) -> Address {
    Address::find_program_address(&[b"vault-authority", market.as_ref()], &ID).0
}

struct Env {
    svm: LiteSVM,
    /// Market authority; also the fee payer for every transaction.
    authority: Keypair,
    /// Owns seat 0 and the source token account.
    trader: Keypair,
    market: Address,
    mint: Address,
    source: Address,
    vault: Address,
    #[allow(dead_code)] // consumed by the withdrawal runtime tests.
    vault_authority: Address,
    seat_slot: Address,
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
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new(&signers, message, blockhash);
    svm.send_transaction(transaction)
        .map_err(|failed| format!("{:?} | {}", failed.err, failed.meta.pretty_logs()))
}

fn stockstream_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: ID,
        accounts,
        data,
    }
}

fn deposit_data(seat_index: u16, amount: u64) -> Vec<u8> {
    let mut data = vec![DEPOSIT_COLLATERAL];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data
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

fn seat(svm: &LiteSVM, market: Address, index: usize) -> TraderSeat {
    let data = market_data(svm, market);
    unsafe {
        ptr::read_unaligned(
            data.as_ptr()
                .add(TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE) as *const TraderSeat,
        )
    }
}

/// Copies `available_collateral` out of the packed seat (a direct field
/// reference would be unaligned UB).
fn seat_collateral(svm: &LiteSVM, market: Address, index: usize) -> i128 {
    let seat = seat(svm, market, index);
    seat.available_collateral
}

/// Copies `global_event_sequence` out of the packed header.
fn event_sequence(svm: &LiteSVM, market: Address) -> u64 {
    let header = header(svm, market);
    header.global_event_sequence
}

fn total_trader_collateral(svm: &LiteSVM, market: Address) -> i128 {
    let mut total = 0i128;
    for index in 0..128 {
        total += seat(svm, market, index).available_collateral;
    }
    total
}

fn token_data(svm: &LiteSVM, address: Address) -> Vec<u8> {
    svm.get_account(&address).unwrap().data
}

fn token_amount(svm: &LiteSVM, address: Address) -> u64 {
    TokenAccount::unpack(&token_data(svm, address)).unwrap().amount
}

/// Full custody environment: an open market with a configured vault, one
/// trader seat, and real Tokenkeg mint/source/vault token accounts.
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

    // InitializeMarket.
    send(
        &mut svm,
        &authority,
        stockstream_ix(
            vec![0],
            vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(authority.pubkey(), true),
            ],
        ),
        &[],
    )
    .expect("InitializeMarket");

    // Open the market and install the authorities (test setup only, exactly as
    // `runtime_settlement.rs` seeds the oracle fields).
    {
        let authority_bytes = authority.pubkey().to_bytes();
        let mut data = market_data(&svm, market);
        unsafe {
            let head = data.as_mut_ptr() as *mut MarketStateHeader;
            (*head).mode = MarketMode::Open as u8;
            (*head).oracle_valid = 1;
            (*head).last_verified_oracle_price = 100;
            (*head).last_verified_oracle_timestamp = 1;
            (*head).maximum_position = 1_000_000;
            (*head).maximum_open_interest = 1_000_000;
            (*head).market_authority = authority_bytes;
            (*head).pause_authority = authority_bytes;
            (*head).emergency_authority = authority_bytes;
        }
        write_market_data(&mut svm, market, data);
    }

    // CreateTraderSeat index 0, owned by `trader`.
    send(
        &mut svm,
        &authority,
        stockstream_ix(
            vec![1, 0, 0],
            vec![
                AccountMeta::new(market, false),
                AccountMeta::new_readonly(trader.pubkey(), true),
            ],
        ),
        &[&trader],
    )
    .expect("CreateTraderSeat");

    // Real SPL Token setup (Tokenkeg): mint, source account, vault account.
    let mint = Address::new_unique();
    let source = Address::new_unique();
    let vault = derive_vault(&market);
    let vault_authority = derive_vault_authority(&market);

    install(&mut svm, mint, vec![0; Mint::LEN], TOKENKEG);
    install(&mut svm, source, vec![0; TokenAccount::LEN], TOKENKEG);
    install(&mut svm, vault, vec![0; TokenAccount::LEN], TOKENKEG);
    let seat_slot = Address::new_unique();
    install(&mut svm, seat_slot, Vec::new(), Address::default());

    let init_mint = token_ix::initialize_mint2(
        &TOKENKEG,
        &mint,
        &authority.pubkey(),
        None,
        DECIMALS,
    )
    .unwrap();
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

    // InitializeVault [9].
    send(
        &mut svm,
        &authority,
        stockstream_ix(
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
        seat_slot,
    }
}

/// The canonical deposit account list (`clients/stockstream` order).
#[allow(clippy::too_many_arguments)]
fn deposit_ix(
    market: Address,
    authority: Address,
    seat_slot: Address,
    source: Address,
    vault: Address,
    mint: Address,
    token_program: Address,
    amount: u64,
) -> Instruction {
    stockstream_ix(
        deposit_data(0, amount),
        vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(seat_slot, false),
            AccountMeta::new(source, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(token_program, false),
        ],
    )
}

fn standard_deposit(env: &Env, amount: u64) -> Instruction {
    deposit_ix(
        env.market,
        env.trader.pubkey(),
        env.seat_slot,
        env.source,
        env.vault,
        env.mint,
        TOKENKEG,
        amount,
    )
}

fn deposit_and_send(
    env: &mut Env,
    instruction: Instruction,
) -> Result<TransactionMetadata, String> {
    send(&mut env.svm, &env.authority, instruction, &[&env.trader])
}

// ---------------------------------------------------------------------------
// Event decoding (`Program data: <base64>`, 100-byte records).
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

fn program_data_records(logs: &[String]) -> Vec<Vec<u8>> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: ").and_then(decode_base64))
        .collect()
}

fn assert_deposit_event(
    logs: &[String],
    market: Address,
    expected_sequence: u64,
    seat_index: u16,
    amount: u64,
    balance: u64,
) {
    let record = program_data_records(logs)
        .into_iter()
        .find(|record| {
            record.len() == 100
                && u16::from_le_bytes([record[0], record[1]]) == COLLATERAL_DEPOSITED
        })
        .expect("a CollateralDeposited program-data record must be emitted");
    assert_eq!(
        u64::from_le_bytes(record[4..12].try_into().unwrap()),
        expected_sequence,
        "event sequence must match the market's advanced global event sequence"
    );
    assert_eq!(
        &record[12..44],
        &market.to_bytes()[..],
        "event market must match"
    );
    assert_eq!(
        u16::from_le_bytes(record[52..54].try_into().unwrap()),
        seat_index
    );
    assert_eq!(
        u64::from_le_bytes(record[54..62].try_into().unwrap()),
        amount,
        "event amount"
    );
    assert_eq!(
        u64::from_le_bytes(record[62..70].try_into().unwrap()),
        balance,
        "event resulting seat balance"
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn deposit_moves_tokens_into_the_vault_and_credits_the_seat() {
    let mut env = setup();

    let source_before = token_amount(&env.svm, env.source);
    let vault_before = token_amount(&env.svm, env.vault);
    let seat_before = seat(&env.svm, env.market, 0).available_collateral;
    let sequence_before = header(&env.svm, env.market).global_event_sequence;
    assert_eq!(source_before, SOURCE_FUNDING);
    assert_eq!(vault_before, 0);
    assert_eq!(seat_before, 0, "a fresh seat starts with no collateral");

    let instruction = standard_deposit(&env, DEPOSIT_AMOUNT);
    let metadata = deposit_and_send(&mut env, instruction).expect("DepositCollateral via real Tokenkeg CPI");
    assert!(
        metadata.compute_units_consumed > 0,
        "deposit must consume compute units, got {}",
        metadata.compute_units_consumed
    );

    let source_after = token_amount(&env.svm, env.source);
    let vault_after = token_amount(&env.svm, env.vault);
    let seat_after = seat(&env.svm, env.market, 0).available_collateral;
    assert_eq!(source_after, source_before - DEPOSIT_AMOUNT, "source decreases exactly");
    assert_eq!(vault_after, vault_before + DEPOSIT_AMOUNT, "vault increases exactly");
    assert_eq!(
        seat_after,
        seat_before + i128::from(DEPOSIT_AMOUNT),
        "the trader's collateral increases exactly"
    );

    // The vault is now exactly backed by the market's liability ledger.
    let head = header(&env.svm, env.market);
    let expected = total_trader_collateral(&env.svm, env.market)
        + i128::from(head.protocol_fee_balance())
        + i128::from(head.insurance_fund_balance())
        - i128::from(head.recognized_bad_debt());
    assert_eq!(
        i128::from(vault_after),
        expected,
        "vault balance must equal the market liability"
    );

    assert_eq!(
        event_sequence(&env.svm, env.market),
        sequence_before + 1,
        "exactly one event sequence is consumed"
    );
    assert_deposit_event(
        &metadata.logs,
        env.market,
        head.global_event_sequence,
        0,
        DEPOSIT_AMOUNT,
        seat_after.max(0) as u64,
    );
}

#[test]
fn deposit_rejects_a_non_owner_and_leaves_state_byte_for_byte_unchanged() {
    let mut env = setup();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let market_before = market_data(&env.svm, env.market);
    let source_before = token_data(&env.svm, env.source);
    let vault_before = token_data(&env.svm, env.vault);

    // Signed by an attacker that is not seat 0's owner.
    let instruction = deposit_ix(
        env.market,
        attacker.pubkey(),
        env.seat_slot,
        env.source,
        env.vault,
        env.mint,
        TOKENKEG,
        DEPOSIT_AMOUNT,
    );
    let result = send(&mut env.svm, &env.authority, instruction, &[&attacker]);
    assert!(result.is_err(), "a non-owner must not deposit for the seat");

    assert_eq!(market_data(&env.svm, env.market), market_before);
    assert_eq!(token_data(&env.svm, env.source), source_before);
    assert_eq!(token_data(&env.svm, env.vault), vault_before);
    assert_eq!(token_amount(&env.svm, env.source), SOURCE_FUNDING);
    assert_eq!(seat_collateral(&env.svm, env.market, 0), 0);
}

#[test]
fn deposit_rejects_wrong_source_mint_vault_and_token_program() {
    let mut env = setup();
    let market_before = market_data(&env.svm, env.market);
    let source_before = token_data(&env.svm, env.source);
    let vault_before = token_data(&env.svm, env.vault);

    // A source token account owned by someone else.
    let foreign = Address::new_unique();
    install(&mut env.svm, foreign, vec![0; TokenAccount::LEN], TOKENKEG);
    let init =
        token_ix::initialize_account3(&TOKENKEG, &foreign, &env.mint, &Address::new_unique())
            .unwrap();
    send(&mut env.svm, &env.authority, init, &[]).unwrap();
    let wrong_source = deposit_ix(
        env.market,
        env.trader.pubkey(),
        env.seat_slot,
        foreign,
        env.vault,
        env.mint,
        TOKENKEG,
        DEPOSIT_AMOUNT,
    );
    assert!(
        deposit_and_send(&mut env, wrong_source).is_err(),
        "a source not owned by the trader must be rejected"
    );

    // A vault that is not the market's derived vault.
    let wrong_vault = deposit_ix(
        env.market,
        env.trader.pubkey(),
        env.seat_slot,
        env.source,
        Address::new_unique(),
        env.mint,
        TOKENKEG,
        DEPOSIT_AMOUNT,
    );
    assert!(
        deposit_and_send(&mut env, wrong_vault).is_err(),
        "a vault that is not the derived PDA must be rejected"
    );

    // A wrong token program.
    let wrong_program = deposit_ix(
        env.market,
        env.trader.pubkey(),
        env.seat_slot,
        env.source,
        env.vault,
        env.mint,
        Address::new_unique(),
        DEPOSIT_AMOUNT,
    );
    assert!(
        deposit_and_send(&mut env, wrong_program).is_err(),
        "a token program other than Tokenkeg must be rejected"
    );

    assert_eq!(market_data(&env.svm, env.market), market_before);
    assert_eq!(token_data(&env.svm, env.source), source_before);
    assert_eq!(token_data(&env.svm, env.vault), vault_before);
    assert_eq!(seat_collateral(&env.svm, env.market, 0), 0);
}

#[test]
fn deposit_rejects_insufficient_balance_zero_amount_and_aliasing() {
    let mut env = setup();
    let market_before = market_data(&env.svm, env.market);
    let source_before = token_data(&env.svm, env.source);

    // More than the source holds.
    let overdraft = standard_deposit(&env, SOURCE_FUNDING + 1);
    assert!(
        deposit_and_send(&mut env, overdraft).is_err(),
        "a deposit larger than the source balance must be rejected"
    );

    // Zero amount.
    let zero = standard_deposit(&env, 0);
    assert!(
        deposit_and_send(&mut env, zero).is_err(),
        "a zero-amount deposit must be rejected"
    );

    // Vault aliased to the source account.
    let aliased = deposit_ix(
        env.market,
        env.trader.pubkey(),
        env.seat_slot,
        env.source,
        env.source,
        env.mint,
        TOKENKEG,
        DEPOSIT_AMOUNT,
    );
    assert!(
        deposit_and_send(&mut env, aliased).is_err(),
        "aliasing the vault to the source must be rejected"
    );

    assert_eq!(market_data(&env.svm, env.market), market_before);
    assert_eq!(token_data(&env.svm, env.source), source_before);
    assert_eq!(seat_collateral(&env.svm, env.market, 0), 0);
}

#[test]
fn deposit_rolls_back_when_the_tokenkeg_cpi_fails() {
    let mut env = setup();

    // Freeze the source account. Every StockStream pre-check still passes
    // (owner, mint, balance are all intact), so execution reaches the SPL
    // `Transfer` CPI, which Tokenkeg refuses with `AccountFrozen`. The runtime
    // must then discard the in-memory seat/header writes entirely.
    let mut source = token_data(&env.svm, env.source);
    source[108] = 2; // AccountState::Frozen
    {
        let mut account = env.svm.get_account(&env.source).unwrap();
        account.data = source;
        env.svm.set_account(env.source, account).unwrap();
    }

    let market_before = market_data(&env.svm, env.market);
    let source_before = token_data(&env.svm, env.source);
    let vault_before = token_data(&env.svm, env.vault);

    let instruction = standard_deposit(&env, DEPOSIT_AMOUNT);
    let result = deposit_and_send(&mut env, instruction);
    assert!(
        result.is_err(),
        "a Tokenkeg CPI failure must abort the whole deposit"
    );

    assert_eq!(
        market_data(&env.svm, env.market),
        market_before,
        "runtime rollback must restore the market byte-for-byte (seat, sequence)"
    );
    assert_eq!(token_data(&env.svm, env.source), source_before);
    assert_eq!(token_data(&env.svm, env.vault), vault_before);
    assert_eq!(
        seat_collateral(&env.svm, env.market, 0),
        0,
        "the seat credit must be rolled back"
    );
}
