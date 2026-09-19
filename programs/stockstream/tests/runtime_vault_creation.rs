#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for opcode 44 (`CreateVaultAccount`), which
//! atomically creates the vault SPL token account via a
//! `SystemProgram::createAccount` CPI signed by the vault PDA's own seeds,
//! then initializes it via a real Tokenkeg `InitializeAccount3` CPI, then
//! configures the market header -- three CPIs/state mutations in one
//! instruction that must all roll back together on any failure.
//!
//! Account ABI under test (`programs/stockstream/src/registry.rs`,
//! `create_vault_account`): exactly 6 accounts --
//! `[market (w), vault (w), payer (signer, w, == market_authority), mint,
//! token_program, system_program]`. `token_program`'s *address* is a
//! hardcoded canonical constant for the CPI itself, but the account still
//! has to be present in this instruction's own account list -- a CPI's
//! target program must be one of the current instruction's accounts for the
//! runtime to locate its executable data -- so it stays in the ABI and is
//! now validated (the original hardening gap was leaving it unchecked, not
//! its presence).

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
use stockstream::{
    state::{MarketStateHeader, MARKET_ACCOUNT_SIZE},
    ID,
};

const CREATE_VAULT_ACCOUNT: u8 = 44;
const INITIALIZE_MARKET: u8 = 0;
const DECIMALS: u8 = 6;

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn derive_vault(market: &Address) -> Address {
    Address::find_program_address(&[b"vault", market.as_ref()], &ID).0
}

/// `pinocchio_system::ID` and `solana_system_interface::program::ID` are the
/// same well-known all-zero address under two different crates' newtypes.
fn system_program_id() -> Address {
    Address::from([0u8; 32])
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

fn stockstream_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: ID,
        accounts,
        data,
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<TransactionMetadata, String> {
    svm.expire_blockhash();
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new(&signers, message, blockhash);
    svm.send_transaction(transaction)
        .map_err(|failed| format!("{:?} | {}", failed.err, failed.meta.pretty_logs()))
}

fn header(svm: &LiteSVM, market: Address) -> MarketStateHeader {
    let data = svm.get_account(&market).unwrap().data;
    unsafe { ptr::read_unaligned(data.as_ptr() as *const MarketStateHeader) }
}

struct Env {
    svm: LiteSVM,
    market: Address,
    authority: Keypair,
    mint: Address,
}

fn create_vault_ix(market: Address, vault: Address, payer: Address, mint: Address) -> Instruction {
    stockstream_ix(
        vec![CREATE_VAULT_ACCOUNT],
        vec![
            writable(market),
            writable(vault),
            writable_signer(payer),
            readonly(mint),
            readonly(TOKENKEG),
            readonly(system_program_id()),
        ],
    )
}

/// A market with an open, funded authority and a real, initialized SPL
/// mint -- everything opcode 44 needs except the vault itself.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let market = Address::new_unique();
    install(&mut svm, market, vec![0; MARKET_ACCOUNT_SIZE], ID);
    send(
        &mut svm,
        &authority,
        stockstream_ix(
            vec![INITIALIZE_MARKET],
            vec![writable(market), readonly_signer(authority.pubkey())],
        ),
        &[&authority],
    )
    .expect("InitializeMarket");

    let mint = Address::new_unique();
    install(&mut svm, mint, vec![0; Mint::LEN], TOKENKEG);
    let init_mint =
        token_ix::initialize_mint2(&TOKENKEG, &mint, &authority.pubkey(), None, DECIMALS).unwrap();
    send(&mut svm, &authority, init_mint, &[]).expect("InitializeMint2");

    Env {
        svm,
        market,
        authority,
        mint,
    }
}

#[test]
fn creates_and_configures_the_vault_in_one_instruction() {
    let mut env = setup();
    let vault = derive_vault(&env.market);

    let metadata = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.market, vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CreateVaultAccount");
    assert!(metadata.compute_units_consumed > 0);

    let account = env
        .svm
        .get_account(&vault)
        .expect("vault must exist after creation");
    assert_eq!(account.owner, TOKENKEG, "vault must be owned by Tokenkeg");
    assert_eq!(account.data.len(), 165);
    let unpacked = TokenAccount::unpack(&account.data).expect("must be a valid token account");
    assert_eq!(unpacked.mint.to_bytes(), env.mint.to_bytes());
    assert_eq!(unpacked.amount, 0);

    let head = header(&env.svm, env.market);
    assert_eq!(head.collateral_mint, env.mint.to_bytes());
    assert_eq!(head.collateral_token_program, TOKENKEG.to_bytes());
    assert_eq!(
        head.reserved_upgrade[1], 1,
        "the market header must be marked vault-configured"
    );
    assert_eq!(head.reserved_upgrade[0], DECIMALS);
}

#[test]
fn rejects_a_payer_who_is_not_the_market_authority() {
    let mut env = setup();
    let vault = derive_vault(&env.market);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();

    let result = send(
        &mut env.svm,
        &attacker,
        create_vault_ix(env.market, vault, attacker.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a payer that is not the market's own authority must be rejected"
    );
    assert!(
        env.svm.get_account(&vault).is_none(),
        "no vault should exist after a rejected authority check"
    );
    assert_eq!(
        header(&env.svm, env.market).reserved_upgrade[1],
        0,
        "the market must remain unconfigured"
    );
}

#[test]
fn rejects_a_vault_address_that_is_not_the_real_pda() {
    let mut env = setup();
    let wrong_vault = Address::new_unique();

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.market, wrong_vault, env.authority.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a non-derived vault address must be rejected"
    );
    assert!(env.svm.get_account(&wrong_vault).is_none());
    assert_eq!(header(&env.svm, env.market).reserved_upgrade[1], 0);
}

#[test]
fn rejects_recreating_an_already_existing_vault() {
    let mut env = setup();
    let vault = derive_vault(&env.market);
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.market, vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("first CreateVaultAccount");
    let vault_before = env.svm.get_account(&vault).unwrap().data;

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.market, vault, env.authority.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "creating the same vault twice must fail cleanly, not reinitialize over live state"
    );
    assert_eq!(env.svm.get_account(&vault).unwrap().data, vault_before);
}

#[test]
fn rejects_an_uninitialized_mint_and_rolls_back_the_vault_creation_cpi() {
    let mut env = setup();
    let vault = derive_vault(&env.market);
    // A Tokenkeg-owned but never-initialized mint: the CreateAccount CPI for
    // the vault succeeds first, then the InitializeAccount3 CPI against this
    // mint fails -- the whole instruction, including the already-executed
    // CreateAccount, must be rolled back atomically.
    let uninitialized_mint = Address::new_unique();
    install(
        &mut env.svm,
        uninitialized_mint,
        vec![0; Mint::LEN],
        TOKENKEG,
    );

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(
            env.market,
            vault,
            env.authority.pubkey(),
            uninitialized_mint,
        ),
        &[],
    );
    assert!(
        result.is_err(),
        "an uninitialized mint must be rejected, not silently accepted"
    );
    assert!(
        env.svm.get_account(&vault).is_none(),
        "the vault CreateAccount CPI must be rolled back along with the failing InitializeAccount3"
    );
    assert_eq!(header(&env.svm, env.market).reserved_upgrade[1], 0);
}

#[test]
fn rejects_a_forged_system_program_account() {
    let mut env = setup();
    let vault = derive_vault(&env.market);
    let forged_system_program = Address::new_unique();

    let result = send(
        &mut env.svm,
        &env.authority,
        stockstream_ix(
            vec![CREATE_VAULT_ACCOUNT],
            vec![
                writable(env.market),
                writable(vault),
                writable_signer(env.authority.pubkey()),
                readonly(env.mint),
                readonly(TOKENKEG),
                readonly(forged_system_program),
            ],
        ),
        &[],
    );
    assert!(
        result.is_err(),
        "a forged system-program account must be rejected"
    );
    assert!(env.svm.get_account(&vault).is_none());
}

#[test]
fn rejects_a_forged_token_program_account() {
    let mut env = setup();
    let vault = derive_vault(&env.market);
    let forged_token_program = Address::new_unique();

    let result = send(
        &mut env.svm,
        &env.authority,
        stockstream_ix(
            vec![CREATE_VAULT_ACCOUNT],
            vec![
                writable(env.market),
                writable(vault),
                writable_signer(env.authority.pubkey()),
                readonly(env.mint),
                readonly(forged_token_program),
                readonly(system_program_id()),
            ],
        ),
        &[],
    );
    assert!(
        result.is_err(),
        "a forged token-program account must be rejected"
    );
    assert!(env.svm.get_account(&vault).is_none());
}

#[test]
fn rejects_a_payer_with_insufficient_balance_for_rent_exemption() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path()).unwrap();

    let authority = Keypair::new();
    // Enough to pay setup fees and stay rent-exempt as a plain account
    // itself (~890,880 lamports), nowhere near enough left over to also
    // cover the ~2,039,280 lamports a 165-byte rent-exempt vault requires.
    svm.airdrop(&authority.pubkey(), 1_500_000).unwrap();

    let market = Address::new_unique();
    install(&mut svm, market, vec![0; MARKET_ACCOUNT_SIZE], ID);
    send(
        &mut svm,
        &authority,
        stockstream_ix(
            vec![INITIALIZE_MARKET],
            vec![writable(market), readonly_signer(authority.pubkey())],
        ),
        &[&authority],
    )
    .expect("InitializeMarket");

    let mint = Address::new_unique();
    install(&mut svm, mint, vec![0; Mint::LEN], TOKENKEG);
    let init_mint =
        token_ix::initialize_mint2(&TOKENKEG, &mint, &authority.pubkey(), None, DECIMALS).unwrap();
    send(&mut svm, &authority, init_mint, &[]).expect("InitializeMint2");

    let vault = derive_vault(&market);
    let result = send(
        &mut svm,
        &authority,
        create_vault_ix(market, vault, authority.pubkey(), mint),
        &[],
    );
    assert!(
        result.is_err(),
        "an underfunded payer must not be able to create the vault"
    );
    assert!(svm.get_account(&vault).is_none());
    assert_eq!(header(&svm, market).reserved_upgrade[1], 0);
}
