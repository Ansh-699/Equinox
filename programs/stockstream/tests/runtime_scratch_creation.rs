#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for opcode 45 (`CreateScratchAccount`), which
//! atomically creates AND initializes the settlement-scratch PDA via a
//! `SystemProgram::createAccount` CPI signed by the program itself.
//!
//! Every other runtime test (`runtime_settlement.rs` etc.) pre-allocates
//! the scratch account directly in the LiteSVM fixture, documented there
//! as "System-Program funding is a separate runtime lifecycle milestone"
//! -- this file is that milestone: it drives the real instruction that
//! performs the CPI, not a test-only shortcut.

use std::path::PathBuf;

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use stockstream::{
    scratch::{derive_settlement_scratch, SETTLEMENT_SCRATCH_LEN},
    state::MARKET_ACCOUNT_SIZE,
    ID,
};

const CREATE_SCRATCH_ACCOUNT: u8 = 45;
const CREATE_TRADER_SEAT: u8 = 1;
const INITIALIZE_MARKET: u8 = 0;
const SEAT: u16 = 0;

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn writable_signer(address: Address) -> AccountMeta {
    AccountMeta::new(address, true)
}
fn readonly_signer(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, true)
}
fn readonly(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}

struct Env {
    svm: LiteSVM,
    market: Address,
}

impl Env {
    fn send(
        &mut self,
        payer: &Keypair,
        signers: &[&Keypair],
        accounts: Vec<AccountMeta>,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let instruction = Instruction {
            program_id: ID,
            accounts,
            data,
        };
        let message = Message::new(&[instruction], Some(&payer.pubkey()));
        let blockhash = self.svm.latest_blockhash();
        let transaction = Transaction::new(signers, message, blockhash);
        self.svm
            .send_transaction(transaction)
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    }

    fn create_seat(&mut self, owner: &Keypair) -> Result<(), String> {
        self.send(
            owner,
            &[owner],
            vec![writable(self.market), readonly_signer(owner.pubkey())],
            vec![CREATE_TRADER_SEAT, 0, 0], // seat_index = 0 (LE u16)
        )
    }

    /// `payer` funds and signs; `trader` proves seat ownership by signing
    /// separately -- the two may be the same keypair (the common case) or
    /// distinct (a sponsor paying for the trader's own scratch account).
    fn create_scratch(
        &mut self,
        payer: &Keypair,
        trader: &Keypair,
        scratch: Address,
    ) -> Result<(), String> {
        let mut data = vec![CREATE_SCRATCH_ACCOUNT];
        data.extend_from_slice(&SEAT.to_le_bytes());
        let signers: Vec<&Keypair> = if payer.pubkey() == trader.pubkey() {
            vec![payer]
        } else {
            vec![payer, trader]
        };
        self.send(
            payer,
            &signers,
            vec![
                writable(self.market),
                readonly_signer(trader.pubkey()),
                writable(scratch),
                writable_signer(payer.pubkey()),
                readonly(solana_address::Address::from(pinocchio_system_id())),
            ],
            data,
        )
    }
}

/// `pinocchio_system::ID` and `solana_system_interface::program::ID` are
/// the same well-known address (`11111111111111111111111111111111111111`)
/// under two different crates' `Address`/`Pubkey` newtypes -- both are
/// just `[u8; 32]` of zeroes, so converting through bytes is exact, not
/// an assumption.
fn pinocchio_system_id() -> [u8; 32] {
    [0u8; 32]
}

fn setup() -> (Env, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");

    let authority = Keypair::new();
    let market = Address::new_unique();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.set_account(
        market,
        Account {
            lamports: 10_000_000_000,
            data: vec![0; MARKET_ACCOUNT_SIZE],
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let mut env = Env { svm, market };
    env.send(
        &authority,
        &[&authority],
        vec![writable(market), readonly_signer(authority.pubkey())],
        vec![INITIALIZE_MARKET],
    )
    .expect("InitializeMarket");
    env.create_seat(&authority).expect("CreateTraderSeat");
    (env, authority)
}

#[test]
fn creates_and_initializes_the_scratch_account_in_one_instruction() {
    let (mut env, trader) = setup();
    let scratch = derive_settlement_scratch(&env.market, SEAT, &ID);

    env.create_scratch(&trader, &trader, scratch)
        .expect("CreateScratchAccount");

    let account = env
        .svm
        .get_account(&scratch)
        .expect("scratch account must exist after creation");
    assert_eq!(
        account.owner, ID,
        "scratch must be owned by the StockStream program, not System"
    );
    assert_eq!(
        account.data.len(),
        SETTLEMENT_SCRATCH_LEN,
        "must be the real computed size, not the 12,288-byte upper bound"
    );
    let rent_exempt_minimum = env
        .svm
        .minimum_balance_for_rent_exemption(SETTLEMENT_SCRATCH_LEN);
    assert!(
        account.lamports >= rent_exempt_minimum,
        "must be funded to at least rent-exemption"
    );
    // Initialized content: SettlementScratchHeader::empty(market, trader, seat)
    // starts with the "STKSCR01" discriminator (bytes 0..8).
    assert_eq!(
        &account.data[0..8],
        b"STKSCR01",
        "must be initialized, not left as raw zeroed bytes"
    );
}

#[test]
fn a_sponsor_can_pay_while_the_trader_still_proves_ownership() {
    let (mut env, trader) = setup();
    let sponsor = Keypair::new();
    env.svm.airdrop(&sponsor.pubkey(), 10_000_000_000).unwrap();
    let scratch = derive_settlement_scratch(&env.market, SEAT, &ID);

    env.create_scratch(&sponsor, &trader, scratch)
        .expect("sponsor-paid CreateScratchAccount");

    let account = env
        .svm
        .get_account(&scratch)
        .expect("scratch account must exist");
    assert_eq!(account.owner, ID);
}

#[test]
fn rejects_a_signer_who_does_not_own_the_claimed_seat() {
    let (mut env, _trader) = setup();
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 10_000_000_000).unwrap();
    let scratch = derive_settlement_scratch(&env.market, SEAT, &ID);

    let result = env.create_scratch(&impostor, &impostor, scratch);
    assert!(
        result.is_err(),
        "a signer who never created seat 0 must not be able to create its scratch account"
    );
    assert!(
        env.svm.get_account(&scratch).is_none(),
        "no account should have been created on rejection"
    );
}

#[test]
fn rejects_a_scratch_address_that_is_not_the_real_pda() {
    let (mut env, trader) = setup();
    let wrong_address = Address::new_unique();

    let result = env.create_scratch(&trader, &trader, wrong_address);
    assert!(
        result.is_err(),
        "a non-derived address must be rejected, not silently accepted as the scratch account"
    );
}

#[test]
fn rejects_recreating_an_already_created_scratch_account() {
    let (mut env, trader) = setup();
    let scratch = derive_settlement_scratch(&env.market, SEAT, &ID);
    env.create_scratch(&trader, &trader, scratch)
        .expect("first CreateScratchAccount");

    let result = env.create_scratch(&trader, &trader, scratch);
    assert!(result.is_err(), "creating the same scratch account twice must fail cleanly, not double-charge rent or reinitialize over live state");
}

#[test]
fn rejects_the_scratch_address_colliding_with_the_market_or_payer() {
    let (mut env, trader) = setup();
    let market = env.market;

    // Scratch == market: an obviously wrong instruction, must never be
    // accepted as "the scratch account happens to equal the market".
    let result = env.create_scratch(&trader, &trader, market);
    assert!(
        result.is_err(),
        "scratch account must never be allowed to alias the market account"
    );

    let trader_pubkey = trader.pubkey();
    let result = env.create_scratch(&trader, &trader, trader_pubkey);
    assert!(
        result.is_err(),
        "scratch account must never be allowed to alias the trader/payer account"
    );
}
