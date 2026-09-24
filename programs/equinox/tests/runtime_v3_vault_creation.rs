#![cfg(feature = "runtime-tests")]
//! Real-SVM proof for the V3 vault-creation lifecycle (opcode 56,
//! `CREATE_V3_VAULT_ACCOUNT`) followed by a real Tokenkeg-transfer deposit
//! (opcode 53, `DEPOSIT_COLLATERAL_V3`).
//!
//! A 4,096-byte `STKMK003` core is built entirely from the program's own
//! opcodes: the core account is created with opcode 46 (kind 0), then
//! activated with opcode 47 against a registered instrument whose exchange
//! carries a real, initialized SPL collateral mint. Opcode 56 then creates the
//! vault token account via a `SystemProgram::CreateAccount` CPI signed by the
//! vault PDA's own seeds plus a real Tokenkeg `InitializeAccount3` CPI that
//! embeds the `["vault-authority", core]` PDA as the SPL owner. Finally a
//! funded source ATA owned by the market authority deposits through opcode 53,
//! which executes a real SPL `Transfer` CPI into that vault and credits the
//! seat ledger.
//!
//! Every instruction is sent through `svm.send_transaction` -- the handlers are
//! never called directly, so the on-chain CPI path is genuinely exercised.

use std::path::PathBuf;

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
    magicblock::DELEGATION_PROGRAM_ID,
    registry::{
        derive_instrument, EXCHANGE_CONFIG_VERSION, EXCHANGE_DISCRIMINATOR, EXCHANGE_SIZE,
        INSTRUMENT_DISCRIMINATOR, INSTRUMENT_SIZE,
    },
    state::TRADER_SEAT_SIZE,
    v3::{
        derive_book_page_v3, derive_event_shard_v3, derive_market_core_v3, derive_seat_shard_v3,
        V3_BOOK_PAGES_PER_SIDE, V3_CORE_COMMIT_PHASE_OFFSET, V3_CORE_DELEGATION_STATUS_OFFSET,
        V3_CORE_MARKET_AUTHORITY_OFFSET, V3_CORE_MODE_OFFSET, V3_CORE_ORACLE_CONFIDENCE_OFFSET,
        V3_CORE_ORACLE_PRICE_OFFSET, V3_CORE_ORACLE_TIMESTAMP_OFFSET, V3_CORE_ORACLE_VALID_OFFSET,
        V3_CORE_RISK_CONFIG_VERSION_OFFSET, V3_EVENT_SHARD_SIZE, V3_MARKET_CORE_SIZE,
        V3_SEAT_AVAILABLE_COLLATERAL_OFFSET, V3_SEAT_SHARD_SIZE,
    },
    ID,
};

const CREATE_V3_ACCOUNT: u8 = 46;
const INITIALIZE_V3_MARKET: u8 = 47;
const CREATE_V3_TRADER_SEAT: u8 = 49;
const DEPOSIT_COLLATERAL_V3: u8 = 53;
const CREATE_V3_VAULT_ACCOUNT: u8 = 56;
const RECONCILE_VAULT_V3: u8 = 55;
const WITHDRAW_COLLATERAL_V3: u8 = 54;
const DECIMALS: u8 = 6;
const SOURCE_FUNDING: u64 = 10_000;
const DEPOSIT_AMOUNT: u64 = 400;
/// V3 shard header size: 8 (discriminator) + 2 (layout version) + 1 (shard
/// index) + 1 (reserved) + 32 (parent core). Fixed 256-byte seats follow.
const V3_SHARD_HEADER_SIZE: usize = 44;
/// The exchange's collateral mint lives at this offset in the 256-byte
/// exchange account (`registry::exchange_offset::COLLATERAL_MINT`, kept
/// private in the crate).
const EXCHANGE_COLLATERAL_MINT_OFFSET: usize = 157;

fn program_path() -> PathBuf {
    std::env::var_os("EQUINOX_TEST_SBF")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/equinox.so")
        })
}

fn solana_address(address: pinocchio::Address) -> Address {
    Address::new_from_array(address.to_bytes())
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

fn equinox_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: solana_address(ID),
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

/// Opcode 46: creates one V3 account (`[core, page, shard]` family) with the
/// parent account as the read-only seed root.
fn send_create(
    svm: &mut LiteSVM,
    payer: &Keypair,
    parent: Address,
    target: Address,
    kind: u8,
    index: u8,
) -> Result<(), String> {
    svm.expire_blockhash();
    let instruction = Instruction {
        program_id: solana_address(ID),
        accounts: vec![
            readonly(parent),
            writable(target),
            writable_signer(payer.pubkey()),
            readonly(system_program_id()),
        ],
        data: vec![CREATE_V3_ACCOUNT, kind, index],
    };
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let transaction = Transaction::new(&[payer], message, svm.latest_blockhash());
    svm.send_transaction(transaction)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

/// Opcode 47: activates the structural core under the exchange listing
/// authority, writing the market authority and collateral mint into the core.
fn activate(
    svm: &mut LiteSVM,
    authority: &Keypair,
    exchange: Address,
    instrument: Address,
    core: Address,
    mint: Address,
) -> Result<(), String> {
    svm.expire_blockhash();
    let instruction = Instruction {
        program_id: solana_address(ID),
        accounts: vec![
            readonly(exchange),
            readonly(instrument),
            writable(core),
            AccountMeta::new_readonly(authority.pubkey(), true),
            readonly(mint),
        ],
        data: vec![INITIALIZE_V3_MARKET],
    };
    let message = Message::new(&[instruction], Some(&authority.pubkey()));
    let transaction = Transaction::new(&[authority], message, svm.latest_blockhash());
    svm.send_transaction(transaction)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn derive_vault(core: &Address) -> Address {
    Address::find_program_address(&[b"vault", core.as_ref()], &ID).0
}

fn derive_vault_authority(core: &Address) -> Address {
    Address::find_program_address(&[b"vault-authority", core.as_ref()], &ID).0
}

fn token_amount(svm: &LiteSVM, address: Address) -> u64 {
    TokenAccount::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

/// `available_collateral` of a V3 seat inside its shard (i128 LE at
/// `seat_start + V3_SEAT_AVAILABLE_COLLATERAL_OFFSET`).
fn seat_available_collateral(svm: &LiteSVM, shard: Address, slot: usize) -> i128 {
    let data = svm.get_account(&shard).unwrap().data;
    let start =
        V3_SHARD_HEADER_SIZE + slot * TRADER_SEAT_SIZE + V3_SEAT_AVAILABLE_COLLATERAL_OFFSET;
    i128::from_le_bytes(data[start..start + 16].try_into().unwrap())
}

fn create_mint(svm: &mut LiteSVM, authority: &Keypair) -> Address {
    let mint = Address::new_unique();
    install(svm, mint, vec![0; Mint::LEN], TOKENKEG);
    let init =
        token_ix::initialize_mint2(&TOKENKEG, &mint, &authority.pubkey(), None, DECIMALS).unwrap();
    send(svm, authority, init, &[]).expect("InitializeMint2");
    mint
}

/// LiteSVM's genesis Clock is `Clock { slot: MAINNET_DEFAULT_SLOT,
/// ..Default::default() }` and is never advanced by `send_transaction`, so the
/// on-chain `unix_timestamp` observed by `Clock::get()` is deterministically
/// 0. Seeding the core's oracle timestamp to 0 therefore satisfies
/// `validate_v3_oracle_freshness` (`now - 10 <= timestamp <= now + 2`) for the
/// whole test. This is the same test-setup seeding pattern the V2 runtime
/// tests use for the market's oracle fields.
fn set_core_oracle(svm: &mut LiteSVM, core: Address) {
    let mut account = svm.get_account(&core).expect("core must exist");
    account.data[V3_CORE_ORACLE_VALID_OFFSET] = 1;
    account.data[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
        .copy_from_slice(&100i64.to_le_bytes());
    account.data[V3_CORE_ORACLE_TIMESTAMP_OFFSET..V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
        .copy_from_slice(&0u64.to_le_bytes());
    account.data[V3_CORE_ORACLE_CONFIDENCE_OFFSET..V3_CORE_ORACLE_CONFIDENCE_OFFSET + 8]
        .copy_from_slice(&0u64.to_le_bytes());
    svm.set_account(core, account).unwrap();
}

fn set_core_risk_version(svm: &mut LiteSVM, core: Address, version: u8) {
    let mut account = svm.get_account(&core).expect("core must exist");
    account.data[V3_CORE_RISK_CONFIG_VERSION_OFFSET] = version;
    svm.set_account(core, account).unwrap();
}

fn set_core_mode(svm: &mut LiteSVM, core: Address, mode: u8) {
    let mut account = svm.get_account(&core).expect("core must exist");
    account.data[V3_CORE_MODE_OFFSET] = mode;
    svm.set_account(core, account).unwrap();
}

fn set_core_delegation_status(svm: &mut LiteSVM, core: Address, status: u8) {
    let mut account = svm.get_account(&core).expect("core must exist");
    account.data[V3_CORE_DELEGATION_STATUS_OFFSET] = status;
    svm.set_account(core, account).unwrap();
}

/// Opcode 56 instruction data is the single byte `[56]`; the six accounts are
/// `[core (ro), vault (w), authority (signer, w), mint (ro), token_program
/// (ro), system_program (ro)]`.
fn create_vault_ix(
    core: Address,
    vault: Address,
    authority: Address,
    mint: Address,
) -> Instruction {
    equinox_ix(
        vec![CREATE_V3_VAULT_ACCOUNT],
        vec![
            readonly(core),
            writable(vault),
            writable_signer(authority),
            readonly(mint),
            readonly(TOKENKEG),
            readonly(system_program_id()),
        ],
    )
}

/// Full V3 fixture: a real activated core, all four seat shards and all four
/// event shards, the market authority's own funded source ATA and its trader
/// seat, with the vault deliberately left uncreated (opcode 56 must create it).
struct Env {
    svm: LiteSVM,
    authority: Keypair,
    core: Address,
    mint: Address,
    vault: Address,
    vault_authority: Address,
    source: Address,
    seat_shards: [Address; 4],
    event_shards: [Address; 4],
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(solana_address(ID), program_path())
        .expect("SBF artifact must load");
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();

    // A real, initialized SPL mint; this becomes the exchange's collateral
    // mint and therefore `core[76..108]`.
    let mint = create_mint(&mut svm, &authority);

    // Exchange fixture: listing authority == `authority`, collateral mint
    // wired to the real mint (the same shape `runtime_v3_creation.rs` uses).
    let exchange = Address::new_unique();
    let mut exchange_data = vec![0; EXCHANGE_SIZE];
    exchange_data[0..8].copy_from_slice(&EXCHANGE_DISCRIMINATOR);
    exchange_data[8..10].copy_from_slice(&EXCHANGE_CONFIG_VERSION.to_le_bytes());
    exchange_data[10] = 1;
    exchange_data[11..43].copy_from_slice(authority.pubkey().as_ref());
    exchange_data[EXCHANGE_COLLATERAL_MINT_OFFSET..EXCHANGE_COLLATERAL_MINT_OFFSET + 32]
        .copy_from_slice(mint.as_ref());
    svm.set_account(
        exchange,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(EXCHANGE_SIZE),
            data: exchange_data,
            owner: solana_address(ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Instrument fixture (registered, valid oracle fields for opcode 47).
    let instrument_id = [9; 32];
    let pinocchio_exchange = pinocchio::Address::new_from_array(exchange.to_bytes());
    let instrument = solana_address(derive_instrument(&ID, &pinocchio_exchange, &instrument_id));
    let mut instrument_data = vec![0; INSTRUMENT_SIZE];
    instrument_data[0..8].copy_from_slice(&INSTRUMENT_DISCRIMINATOR);
    instrument_data[8..10].copy_from_slice(&1u16.to_le_bytes());
    instrument_data[10] = 1;
    instrument_data[11..43].copy_from_slice(&instrument_id);
    instrument_data[75..79].copy_from_slice(&922u32.to_le_bytes());
    instrument_data[79] = 1;
    instrument_data[107..111].copy_from_slice(&(-6i32).to_le_bytes());
    svm.set_account(
        instrument,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(INSTRUMENT_SIZE),
            data: instrument_data,
            owner: solana_address(ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Core via opcode 46 (kind 0).
    let pinocchio_instrument = pinocchio::Address::new_from_array(instrument.to_bytes());
    let core = solana_address(derive_market_core_v3(&ID, &pinocchio_instrument));
    send_create(&mut svm, &authority, instrument, core, 0, 0).expect("create V3 core");
    let core_account = svm.get_account(&core).expect("core created");
    assert_eq!(core_account.data.len(), V3_MARKET_CORE_SIZE);
    assert_eq!(&core_account.data[0..8], b"STKMK003");

    // Activate via opcode 47.
    activate(&mut svm, &authority, exchange, instrument, core, mint).expect("activate V3 core");
    let active = svm.get_account(&core).unwrap().data;
    assert_eq!(
        &active[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32],
        authority.pubkey().as_ref()
    );
    assert_eq!(&active[76..108], mint.as_ref());

    // Seat + event shards via opcode 46.
    let pinocchio_core = pinocchio::Address::new_from_array(core.to_bytes());
    let mut seat_shards = [Address::from([0u8; 32]); 4];
    for index in 0..4u8 {
        let shard = solana_address(derive_seat_shard_v3(&ID, &pinocchio_core, index));
        send_create(&mut svm, &authority, core, shard, 2, index).expect("create seat shard");
        let account = svm.get_account(&shard).expect("seat shard exists");
        assert_eq!(account.data.len(), V3_SEAT_SHARD_SIZE);
        assert_eq!(&account.data[0..8], b"STKST003");
        seat_shards[index as usize] = shard;
    }
    let mut event_shards = [Address::from([0u8; 32]); 4];
    for index in 0..4u8 {
        let shard = solana_address(derive_event_shard_v3(&ID, &pinocchio_core, index));
        send_create(&mut svm, &authority, core, shard, 3, index).expect("create event shard");
        let account = svm.get_account(&shard).expect("event shard exists");
        assert_eq!(account.data.len(), V3_EVENT_SHARD_SIZE);
        assert_eq!(&account.data[0..8], b"STKEV003");
        event_shards[index as usize] = shard;
    }

    // Funded source ATA owned by the market authority, same mint.
    let source = Address::new_unique();
    install(&mut svm, source, vec![0; TokenAccount::LEN], TOKENKEG);
    let init_source =
        token_ix::initialize_account3(&TOKENKEG, &source, &mint, &authority.pubkey()).unwrap();
    send(&mut svm, &authority, init_source, &[]).expect("InitializeAccount3 source");
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

    // The market authority's own trader seat (opcode 49, seat index 0).
    let mut seat_data = vec![CREATE_V3_TRADER_SEAT];
    seat_data.extend_from_slice(&0u16.to_le_bytes());
    let seat_instruction = equinox_ix(
        seat_data,
        vec![
            writable(core),
            writable(seat_shards[0]),
            writable(seat_shards[1]),
            writable(seat_shards[2]),
            writable(seat_shards[3]),
            writable(event_shards[0]),
            writable(event_shards[1]),
            writable(event_shards[2]),
            writable(event_shards[3]),
            readonly_signer(authority.pubkey()),
        ],
    );
    send(&mut svm, &authority, seat_instruction, &[]).expect("create V3 trader seat");

    // Seed the core oracle so the deposit's on-chain freshness check passes.
    set_core_oracle(&mut svm, core);

    Env {
        svm,
        authority,
        core,
        mint,
        vault: derive_vault(&core),
        vault_authority: derive_vault_authority(&core),
        source,
        seat_shards,
        event_shards,
    }
}

/// Opcode 53: `[core (w), seat_shard (w), event_shard[4] (w), authority
/// (signer), source (w), vault (w), mint (ro), token_program (ro)]`, data
/// `[53, seat_index:u16, amount:u64]`.
#[allow(clippy::too_many_arguments)]
fn deposit_ix(
    core: Address,
    seat_shard: Address,
    event_shards: &[Address; 4],
    authority: Address,
    source: Address,
    vault: Address,
    mint: Address,
    token_program: Address,
    seat_index: u16,
    amount: u64,
) -> Instruction {
    let mut data = vec![DEPOSIT_COLLATERAL_V3];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    equinox_ix(
        data,
        vec![
            writable(core),
            writable(seat_shard),
            writable(event_shards[0]),
            writable(event_shards[1]),
            writable(event_shards[2]),
            writable(event_shards[3]),
            readonly_signer(authority),
            writable(source),
            writable(vault),
            readonly(mint),
            readonly(token_program),
        ],
    )
}

/// The canonical, fully valid deposit the positive test relies on.
fn standard_deposit(env: &Env) -> Instruction {
    deposit_ix(
        env.core,
        env.seat_shards[0],
        &env.event_shards,
        env.authority.pubkey(),
        env.source,
        env.vault,
        env.mint,
        TOKENKEG,
        0,
        DEPOSIT_AMOUNT,
    )
}

#[test]
fn creates_the_v3_vault_and_deposits_through_real_cpis() {
    let mut env = setup();

    // Opcode 56: the program signs the vault PDA's CreateAccount and
    // InitializeAccount3 CPIs itself.
    let metadata = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    assert!(
        metadata.compute_units_consumed > 0,
        "vault creation must execute on-chain, got {} CUs",
        metadata.compute_units_consumed
    );

    // The vault is a real 165-byte Tokenkeg account whose SPL owner is the
    // vault-authority PDA and whose mint is the core's collateral mint. It is
    // L1 custody: it must never be owned by the MagicBlock delegation program.
    let account = env
        .svm
        .get_account(&env.vault)
        .expect("vault must exist after opcode 56");
    assert_eq!(account.owner, TOKENKEG, "vault must be owned by Tokenkeg");
    assert_ne!(
        account.owner, DELEGATION_PROGRAM_ID,
        "the vault must never be owned by the MagicBlock delegation program"
    );
    assert_eq!(
        account.data.len(),
        165,
        "vault must be a 165-byte token account"
    );
    let unpacked = TokenAccount::unpack(&account.data).expect("valid token account");
    assert_eq!(
        unpacked.mint.to_bytes(),
        env.mint.to_bytes(),
        "vault mint must equal the core's collateral mint"
    );
    assert_eq!(
        unpacked.owner.to_bytes(),
        env.vault_authority.to_bytes(),
        "vault owner must be the vault-authority PDA"
    );
    assert_eq!(unpacked.amount, 0);

    // Opcode 53: a funded source ATA owned by the market authority deposits
    // into the fresh vault through a real Tokenkeg Transfer CPI.
    let vault_before = token_amount(&env.svm, env.vault);
    let seat_before = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
    let source_before = token_amount(&env.svm, env.source);
    assert_eq!(vault_before, 0);
    assert_eq!(seat_before, 0, "a fresh seat starts with no collateral");
    assert_eq!(source_before, SOURCE_FUNDING);

    let deposit = standard_deposit(&env);
    let deposit_metadata = send(&mut env.svm, &env.authority, deposit, &[])
        .expect("DEPOSIT_COLLATERAL_V3 via real Tokenkeg CPI");
    assert!(
        deposit_metadata.compute_units_consumed > 0,
        "deposit must execute on-chain, got {} CUs",
        deposit_metadata.compute_units_consumed
    );

    let vault_after = token_amount(&env.svm, env.vault);
    let seat_after = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
    let source_after = token_amount(&env.svm, env.source);
    assert_eq!(
        vault_after,
        vault_before + DEPOSIT_AMOUNT,
        "vault token balance must increase by exactly the deposit amount"
    );
    assert_eq!(
        seat_after,
        seat_before + i128::from(DEPOSIT_AMOUNT),
        "the seat's available collateral must increase by exactly the deposit"
    );
    assert_eq!(
        source_after,
        source_before - DEPOSIT_AMOUNT,
        "the source must decrease by exactly the deposit"
    );

    // The deposit flowed through a real SPL Transfer CPI; the vault stays a
    // Tokenkeg-owned L1 account and is never delegated to MagicBlock.
    let after = env
        .svm
        .get_account(&env.vault)
        .expect("vault still exists after deposit");
    assert_eq!(after.owner, TOKENKEG);
    assert_ne!(after.owner, DELEGATION_PROGRAM_ID);
}

#[test]
fn rejects_a_vault_that_is_not_the_derived_pda() {
    let mut env = setup();
    let wrong_vault = Address::new_unique();

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, wrong_vault, env.authority.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a vault address that is not find_program_address([\"vault\", core]) must be rejected"
    );
    assert!(env.svm.get_account(&wrong_vault).is_none());
    assert!(
        env.svm.get_account(&env.vault).is_none(),
        "the real vault must not be created by a rejected instruction"
    );
}

#[test]
fn rejects_a_mint_that_does_not_match_the_core_collateral_mint() {
    let mut env = setup();
    let other_mint = create_mint(&mut env.svm, &env.authority);
    assert_ne!(other_mint, env.mint);

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), other_mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a mint that does not equal core[76..108] must be rejected"
    );
    assert!(
        env.svm.get_account(&env.vault).is_none(),
        "no vault may be created against a mismatched mint"
    );
}

#[test]
fn rejects_a_core_whose_risk_config_revision_is_stale() {
    let mut env = setup();
    // The handler refuses to reinterpret a core whose risk-config revision
    // byte (371) is anything but the current layout version.
    set_core_risk_version(&mut env.svm, env.core, 1);

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a core whose revision byte 371 is not the current risk-config version must be rejected"
    );
    assert!(
        env.svm.get_account(&env.vault).is_none(),
        "no vault may be created against a stale core layout"
    );
}

#[test]
fn rejects_an_authority_that_is_not_the_market_authority() {
    let mut env = setup();
    let impostor = Keypair::new();
    env.svm.airdrop(&impostor.pubkey(), 10_000_000_000).unwrap();

    let result = send(
        &mut env.svm,
        &impostor,
        create_vault_ix(env.core, env.vault, impostor.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "a signer that is not core[44..76] (the market authority) must be rejected"
    );
    assert!(
        env.svm.get_account(&env.vault).is_none(),
        "no vault may be created by a non-authority"
    );
}

#[test]
fn a_second_vault_creation_on_the_same_vault_fails_safely() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("first CREATE_V3_VAULT_ACCOUNT");
    let vault_before = env.svm.get_account(&env.vault).unwrap().data;

    let result = send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    );
    assert!(
        result.is_err(),
        "creating an already-existing vault (data_len != 0) must fail, never reinitialize over live state"
    );
    let after = env.svm.get_account(&env.vault).unwrap();
    assert_eq!(
        after.data, vault_before,
        "a rejected recreation must leave the vault byte-for-byte unchanged"
    );
    assert_eq!(after.owner, TOKENKEG);
    assert_ne!(after.owner, DELEGATION_PROGRAM_ID);
}

#[test]
fn deposit_rejects_a_mint_that_does_not_match_the_core_collateral_mint() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    let other_mint = create_mint(&mut env.svm, &env.authority);
    assert_ne!(other_mint, env.mint);

    let vault_before = token_amount(&env.svm, env.vault);
    let seat_before = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
    let result = send(
        &mut env.svm,
        &env.authority,
        deposit_ix(
            env.core,
            env.seat_shards[0],
            &env.event_shards,
            env.authority.pubkey(),
            env.source,
            env.vault,
            other_mint,
            TOKENKEG,
            0,
            DEPOSIT_AMOUNT,
        ),
        &[],
    );
    assert!(
        result.is_err(),
        "a deposit whose mint does not equal core[76..108] must be rejected"
    );
    assert_eq!(
        token_amount(&env.svm, env.vault),
        vault_before,
        "no tokens may move on a rejected deposit"
    );
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 0),
        seat_before,
        "the seat collateral must not change on a rejected deposit"
    );
}

#[test]
fn deposit_rejects_an_unactivated_core() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    // Simulate a structurally created but never-activated core: mode 0.
    set_core_mode(&mut env.svm, env.core, 0);

    let vault_before = token_amount(&env.svm, env.vault);
    let seat_before = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
    let deposit = standard_deposit(&env);
    let result = send(&mut env.svm, &env.authority, deposit, &[]);
    assert!(
        result.is_err(),
        "a deposit against a core in mode 0 (never activated) must be rejected"
    );
    assert_eq!(token_amount(&env.svm, env.vault), vault_before);
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 0),
        seat_before
    );
}

#[test]
fn deposit_rejects_a_core_that_is_delegated_or_undelegating() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    // `deposit_collateral_v3` rejects Delegated (1) and Undelegating (2) cores
    // outright: L1 custody must not run against a delegated hot domain.
    for status in [1u8, 2u8] {
        set_core_delegation_status(&mut env.svm, env.core, status);
        let vault_before = token_amount(&env.svm, env.vault);
        let seat_before = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
        let deposit = standard_deposit(&env);
        let result = send(&mut env.svm, &env.authority, deposit, &[]);
        assert!(
            result.is_err(),
            "a deposit against a core with delegation status {status} must be rejected"
        );
        assert_eq!(token_amount(&env.svm, env.vault), vault_before);
        assert_eq!(
            seat_available_collateral(&env.svm, env.seat_shards[0], 0),
            seat_before
        );
    }
}

#[test]
fn deposit_rejects_a_non_derived_user_controlled_vault() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");

    // A perfectly valid Tokenkeg account owned by the authority and holding
    // the correct mint -- but at a user-controlled address, not the derived
    // `["vault", core]` PDA. The deposit must refuse to treat it as the vault.
    let fake_vault = Address::new_unique();
    install(
        &mut env.svm,
        fake_vault,
        vec![0; TokenAccount::LEN],
        TOKENKEG,
    );
    let init_fake =
        token_ix::initialize_account3(&TOKENKEG, &fake_vault, &env.mint, &env.authority.pubkey())
            .unwrap();
    send(&mut env.svm, &env.authority, init_fake, &[]).expect("InitializeAccount3 fake vault");
    let fund_fake = token_ix::mint_to(
        &TOKENKEG,
        &env.mint,
        &fake_vault,
        &env.authority.pubkey(),
        &[],
        1,
    )
    .unwrap();
    send(&mut env.svm, &env.authority, fund_fake, &[]).expect("fund fake vault");

    let vault_before = token_amount(&env.svm, env.vault);
    let fake_before = token_amount(&env.svm, fake_vault);
    let seat_before = seat_available_collateral(&env.svm, env.seat_shards[0], 0);
    let result = send(
        &mut env.svm,
        &env.authority,
        deposit_ix(
            env.core,
            env.seat_shards[0],
            &env.event_shards,
            env.authority.pubkey(),
            env.source,
            fake_vault,
            env.mint,
            TOKENKEG,
            0,
            DEPOSIT_AMOUNT,
        ),
        &[],
    );
    assert!(
        result.is_err(),
        "a user-controlled token account at a non-derived address must not substitute for the vault PDA"
    );
    assert_eq!(
        token_amount(&env.svm, env.vault),
        vault_before,
        "the real vault must not be touched"
    );
    assert_eq!(
        token_amount(&env.svm, fake_vault),
        fake_before,
        "the fake vault must not receive any tokens"
    );
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 0),
        seat_before
    );
}

/// Any trader, not only the market authority, funds their own seat from a
/// source they own; nobody can credit or debit a seat they do not own.
#[test]
fn a_non_authority_trader_deposits_only_into_their_own_seat() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    let trader = Keypair::new();
    env.svm.airdrop(&trader.pubkey(), 1_000_000_000).unwrap();
    let mut seat_data = vec![CREATE_V3_TRADER_SEAT];
    seat_data.extend_from_slice(&1u16.to_le_bytes());
    let mut seat_metas = vec![writable(env.core)];
    seat_metas.extend(env.seat_shards.iter().map(|shard| writable(*shard)));
    seat_metas.extend(env.event_shards.iter().map(|shard| writable(*shard)));
    seat_metas.push(readonly_signer(trader.pubkey()));
    send(
        &mut env.svm,
        &trader,
        equinox_ix(seat_data, seat_metas),
        &[],
    )
    .expect("trader seat");

    let source = Address::new_unique();
    install(&mut env.svm, source, vec![0; TokenAccount::LEN], TOKENKEG);
    let init =
        token_ix::initialize_account3(&TOKENKEG, &source, &env.mint, &trader.pubkey()).unwrap();
    send(&mut env.svm, &env.authority, init, &[]).expect("trader source");
    let mint_to = token_ix::mint_to(
        &TOKENKEG,
        &env.mint,
        &source,
        &env.authority.pubkey(),
        &[],
        SOURCE_FUNDING,
    )
    .unwrap();
    send(&mut env.svm, &env.authority, mint_to, &[]).expect("fund trader source");

    let deposit = |seat_index| {
        deposit_ix(
            env.core,
            env.seat_shards[0],
            &env.event_shards,
            trader.pubkey(),
            source,
            env.vault,
            env.mint,
            TOKENKEG,
            seat_index,
            DEPOSIT_AMOUNT,
        )
    };
    let into_authority_seat = deposit(0);
    let into_own_seat = deposit(1);
    assert!(
        send(&mut env.svm, &trader, into_authority_seat, &[]).is_err(),
        "a trader must not credit another trader's seat"
    );
    send(&mut env.svm, &trader, into_own_seat, &[]).expect("trader deposits into own seat");
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 1),
        i128::from(DEPOSIT_AMOUNT)
    );
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 0),
        0
    );
    assert_eq!(token_amount(&env.svm, env.vault), DEPOSIT_AMOUNT);
}

/// MagicBlock's undelegation callback hands the core back still marked
/// Undelegating. Reconciliation, the mandatory post-restore step, finalizes it
/// only once every one of the 27 execution accounts is program-owned again.
#[test]
fn reconcile_finalizes_a_core_returned_by_undelegation() {
    let mut env = setup();
    send(
        &mut env.svm,
        &env.authority,
        create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint),
        &[],
    )
    .expect("CREATE_V3_VAULT_ACCOUNT");
    let pinocchio_core = pinocchio::Address::new_from_array(env.core.to_bytes());
    let mut pages = Vec::new();
    for index in 0..(2 * V3_BOOK_PAGES_PER_SIDE) as u8 {
        let (side, page) = (
            index / V3_BOOK_PAGES_PER_SIDE as u8,
            index % V3_BOOK_PAGES_PER_SIDE as u8,
        );
        let target = solana_address(derive_book_page_v3(&ID, &pinocchio_core, side, page));
        send_create(&mut env.svm, &env.authority, env.core, target, 1, index).expect("book page");
        pages.push(target);
    }
    let deposit = standard_deposit(&env);
    send(&mut env.svm, &env.authority, deposit, &[]).expect("deposit");
    let mut core = env.svm.get_account(&env.core).unwrap();
    core.data[V3_CORE_DELEGATION_STATUS_OFFSET] = 2;
    core.data[V3_CORE_COMMIT_PHASE_OFFSET] = 2;
    env.svm.set_account(env.core, core).unwrap();

    let mut metas = vec![writable(env.core)];
    metas.extend(pages.iter().map(|page| writable(*page)));
    metas.extend(env.seat_shards.iter().map(|shard| writable(*shard)));
    metas.extend(env.event_shards.iter().map(|shard| writable(*shard)));
    metas.extend([writable(env.vault), readonly(env.mint), readonly(TOKENKEG)]);
    let reconcile = equinox_ix(vec![RECONCILE_VAULT_V3], metas);

    // A child still owned by the delegation program blocks finalization.
    let mut page = env.svm.get_account(&pages[0]).unwrap();
    let owned_by_program = page.clone();
    page.owner = DELEGATION_PROGRAM_ID;
    env.svm.set_account(pages[0], page).unwrap();
    let before = env.svm.get_account(&env.core).unwrap().data;
    assert!(send(&mut env.svm, &env.authority, reconcile.clone(), &[]).is_err());
    assert_eq!(env.svm.get_account(&env.core).unwrap().data, before);

    env.svm.set_account(pages[0], owned_by_program).unwrap();
    send(&mut env.svm, &env.authority, reconcile, &[]).expect("reconcile finalizes restore");
    let core = env.svm.get_account(&env.core).unwrap().data;
    assert_eq!(core[V3_CORE_DELEGATION_STATUS_OFFSET], 3, "Restored");
    assert_eq!(core[V3_CORE_COMMIT_PHASE_OFFSET], 0, "idle");
    assert_eq!(
        core[V3_CORE_MODE_OFFSET], 1,
        "vault matches liability, market stays active"
    );

    // The restored seat withdraws half its collateral; the seat is debited once.
    set_core_oracle(&mut env.svm, env.core);
    let half = DEPOSIT_AMOUNT / 2;
    let mut data = vec![WITHDRAW_COLLATERAL_V3];
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&half.to_le_bytes());
    let mut metas = vec![writable(env.core)];
    metas.extend(pages.iter().map(|page| writable(*page)));
    metas.extend(env.seat_shards.iter().map(|shard| writable(*shard)));
    metas.extend(env.event_shards.iter().map(|shard| writable(*shard)));
    metas.extend([
        readonly_signer(env.authority.pubkey()),
        writable(env.source),
        readonly(env.mint),
        writable(env.vault),
        readonly(env.vault_authority),
        readonly(TOKENKEG),
    ]);
    send(
        &mut env.svm,
        &env.authority,
        equinox_ix(data, metas),
        &[],
    )
    .expect("withdraw");
    assert_eq!(token_amount(&env.svm, env.vault), DEPOSIT_AMOUNT - half);
    assert_eq!(
        seat_available_collateral(&env.svm, env.seat_shards[0], 0),
        i128::from(DEPOSIT_AMOUNT - half),
        "the seat is debited exactly once"
    );
}

// ── Deposit inbox (opcodes 60/61): deposits while the bundle is delegated ──

const DEPOSIT_TO_INBOX_V3: u8 = 60;
const CLAIM_INBOX_DEPOSIT_V3: u8 = 61;

fn derive_receipt(core: &Address, trader: &Address) -> Address {
    Address::find_program_address(&[b"deposit-receipt-v3", core.as_ref(), trader.as_ref()], &solana_address(ID)).0
}

fn inbox_deposit_ix(env: &Env, amount: u64) -> Instruction {
    let mut data = vec![DEPOSIT_TO_INBOX_V3];
    data.extend_from_slice(&amount.to_le_bytes());
    equinox_ix(
        data,
        vec![
            readonly(env.core),
            writable(derive_receipt(&env.core, &env.authority.pubkey())),
            writable_signer(env.authority.pubkey()),
            writable(env.source),
            writable(env.vault),
            readonly(env.mint),
            readonly(TOKENKEG),
            readonly(system_program_id()),
        ],
    )
}

fn claim_ix(env: &Env, seat_index: u16, receipt: Address) -> Instruction {
    let mut data = vec![CLAIM_INBOX_DEPOSIT_V3];
    data.extend_from_slice(&seat_index.to_le_bytes());
    equinox_ix(
        data,
        vec![
            writable(env.core),
            writable(env.seat_shards[(seat_index / 32) as usize]),
            writable(env.event_shards[0]),
            writable(env.event_shards[1]),
            writable(env.event_shards[2]),
            writable(env.event_shards[3]),
            readonly(receipt),
        ],
    )
}

#[test]
fn inbox_deposit_is_credited_exactly_once_while_the_market_is_delegated() {
    let mut env = setup();
    send(&mut env.svm, &env.authority, create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint), &[]).expect("vault");
    // Delegated: seats cannot take a direct deposit, but the inbox still works.
    set_core_delegation_status(&mut env.svm, env.core, 1);
    assert!({ let ix = standard_deposit(&env); send(&mut env.svm, &env.authority, ix, &[]) }.is_err(), "direct deposits stay L1-only");

    { let ix = inbox_deposit_ix(&env, DEPOSIT_AMOUNT); send(&mut env.svm, &env.authority, ix, &[]) }.expect("DEPOSIT_TO_INBOX_V3");
    assert_eq!(token_amount(&env.svm, env.vault), DEPOSIT_AMOUNT, "tokens reach the vault immediately");
    assert_eq!(seat_available_collateral(&env.svm, env.seat_shards[0], 0), 0, "nothing is credited until claimed");

    let receipt = derive_receipt(&env.core, &env.authority.pubkey());
    { let ix = claim_ix(&env, 0, receipt); send(&mut env.svm, &env.authority, ix, &[]) }.expect("CLAIM_INBOX_DEPOSIT_V3");
    assert_eq!(seat_available_collateral(&env.svm, env.seat_shards[0], 0), i128::from(DEPOSIT_AMOUNT));
    env.svm.expire_blockhash();
    assert!({ let ix = claim_ix(&env, 0, receipt); send(&mut env.svm, &env.authority, ix, &[]) }.is_err(), "a receipt cannot be credited twice");

    // A second deposit credits only the new amount.
    env.svm.expire_blockhash();
    { let ix = inbox_deposit_ix(&env, 7); send(&mut env.svm, &env.authority, ix, &[]) }.expect("second inbox deposit");
    env.svm.expire_blockhash();
    { let ix = claim_ix(&env, 0, receipt); send(&mut env.svm, &env.authority, ix, &[]) }.expect("second claim");
    assert_eq!(seat_available_collateral(&env.svm, env.seat_shards[0], 0), i128::from(DEPOSIT_AMOUNT) + 7);
    assert_eq!(token_amount(&env.svm, env.vault), DEPOSIT_AMOUNT + 7);
}

#[test]
fn inbox_claim_only_credits_the_receipt_owners_seat() {
    let mut env = setup();
    send(&mut env.svm, &env.authority, create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint), &[]).expect("vault");
    { let ix = inbox_deposit_ix(&env, DEPOSIT_AMOUNT); send(&mut env.svm, &env.authority, ix, &[]) }.expect("inbox deposit");
    let receipt = derive_receipt(&env.core, &env.authority.pubkey());
    // Seat 1 is empty / not the receipt owner's: refused.
    assert!({ let ix = claim_ix(&env, 1, receipt); send(&mut env.svm, &env.authority, ix, &[]) }.is_err());
    assert_eq!(seat_available_collateral(&env.svm, env.seat_shards[0], 0), 0);
}

// ── Withdrawal payout (opcode 63): pays committed rollup requests once ──

const CLAIM_WITHDRAWAL_V3: u8 = 63;
/// `TraderSeat` is packed(8): `reserved` starts at 184; its [8..16] is the requested total.
const SEAT_REQUESTED_OFFSET: usize = 192;

fn set_seat_requested(svm: &mut LiteSVM, shard: Address, slot: usize, requested: u64) {
    let mut account = svm.get_account(&shard).unwrap();
    let start = V3_SHARD_HEADER_SIZE + slot * TRADER_SEAT_SIZE + SEAT_REQUESTED_OFFSET;
    account.data[start..start + 8].copy_from_slice(&requested.to_le_bytes());
    svm.set_account(shard, account).unwrap();
}

fn claim_withdrawal_ix(env: &Env, seat_index: u16) -> Instruction {
    let mut data = vec![CLAIM_WITHDRAWAL_V3];
    data.extend_from_slice(&seat_index.to_le_bytes());
    let receipt = Address::find_program_address(&[b"withdraw-receipt-v3", env.core.as_ref(), env.authority.pubkey().as_ref()], &solana_address(ID)).0;
    equinox_ix(
        data,
        vec![
            readonly(env.core),
            readonly(env.seat_shards[(seat_index / 32) as usize]),
            writable_signer(env.authority.pubkey()),
            writable(env.source),
            writable(env.vault),
            readonly(env.vault_authority),
            readonly(env.mint),
            readonly(TOKENKEG),
            writable(receipt),
            readonly(system_program_id()),
        ],
    )
}

#[test]
fn withdrawal_payout_pays_each_committed_request_exactly_once() {
    let mut env = setup();
    send(&mut env.svm, &env.authority, create_vault_ix(env.core, env.vault, env.authority.pubkey(), env.mint), &[]).expect("vault");
    { let ix = standard_deposit(&env); send(&mut env.svm, &env.authority, ix, &[]) }.expect("deposit");
    let before = token_amount(&env.svm, env.source);

    // Nothing requested yet: nothing to pay.
    assert!({ let ix = claim_withdrawal_ix(&env, 0); send(&mut env.svm, &env.authority, ix, &[]) }.is_err());

    // The rollup's request (as committed to L1) is paid once.
    set_seat_requested(&mut env.svm, env.seat_shards[0], 0, 150);
    { let ix = claim_withdrawal_ix(&env, 0); send(&mut env.svm, &env.authority, ix, &[]) }.expect("CLAIM_WITHDRAWAL_V3");
    assert_eq!(token_amount(&env.svm, env.source), before + 150);
    assert_eq!(token_amount(&env.svm, env.vault), DEPOSIT_AMOUNT - 150);
    assert!({ let ix = claim_withdrawal_ix(&env, 0); send(&mut env.svm, &env.authority, ix, &[]) }.is_err(), "no double payout");

    // A later request pays only the difference.
    set_seat_requested(&mut env.svm, env.seat_shards[0], 0, 200);
    { let ix = claim_withdrawal_ix(&env, 0); send(&mut env.svm, &env.authority, ix, &[]) }.expect("second payout");
    assert_eq!(token_amount(&env.svm, env.source), before + 200);
}
