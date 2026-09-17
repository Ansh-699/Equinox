#![cfg(feature = "runtime-tests")]
//! Behavioral control test for the canonical SPL Token program ("Tokenkeg")
//! running inside LiteSVM.
//!
//! This suite asserts only *observable* behavior:
//!
//!   * the Tokenkeg program account exists and is executable,
//!   * every instruction we submit is addressed to the canonical Tokenkeg
//!     public key,
//!   * legitimate initialize / mint / transfer flows update the token state
//!     exactly, and
//!   * malformed or unauthorized flows leave the token state byte-for-byte
//!     unchanged.
//!
//! It does *not* assert how LiteSVM stores the program account: no ELF length,
//! no ProgramData layout, no program-cache branch. The bundled
//! `spl_token-3.5.0.so` install is the thing under test.
//!
//! Instruction bytes come from the official `spl-token-interface` crate (the
//! exact crate and version LiteSVM 0.16.0 dev-depends on), so the encodings are
//! the real legacy SPL Token definitions rather than hand-written shorthand. A
//! golden test pins the resulting byte layouts.
//!
//! `InitializeMint2` / `InitializeAccount3` are used throughout: spl-token
//! 3.5.0's processor dispatches both variants, and neither needs a Rent
//! sysvar account. LiteSVM installs the bundled binary at Tokenkeg; the run
//! below proves the variants execute, it does not assume it.

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::{
    instruction as token_ix,
    state::{Account as TokenAccount, AccountState, Mint},
    ID as TOKEN_PROGRAM_ID,
};

const DECIMALS: u8 = 6;
const MINT_AMOUNT: u64 = 1_000_000;
const TRANSFER_AMOUNT: u64 = 250_000;

/// One mint, two token accounts, and the authorities required to drive them.
struct Fixture {
    svm: LiteSVM,
    payer: Keypair,
    mint_authority: Keypair,
    owner_a: Keypair,
    owner_b: Keypair,
    mint: Address,
    token_a: Address,
    token_b: Address,
}

/// Installs a zeroed, uninitialized, Tokenkeg-owned account at the exact length.
fn install(svm: &mut LiteSVM, address: Address, len: usize) {
    let lamports = svm.minimum_balance_for_rent_exemption(len);
    svm.set_account(
        address,
        Account {
            lamports,
            data: vec![0u8; len],
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Creates the fixture with zeroed, uninitialized accounts of the legacy SPL
/// sizes. No Mint or token Account layout is pre-written: initialization is
/// exercised through real instructions only.
fn fresh() -> Fixture {
    let mut svm = LiteSVM::new();
    let payer = Keypair::new();
    let mint_authority = Keypair::new();
    let owner_a = Keypair::new();
    let owner_b = Keypair::new();

    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    for signer in [&mint_authority, &owner_a, &owner_b] {
        svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
    }

    let mint = Address::new_unique();
    let token_a = Address::new_unique();
    let token_b = Address::new_unique();
    install(&mut svm, mint, Mint::LEN);
    install(&mut svm, token_a, TokenAccount::LEN);
    install(&mut svm, token_b, TokenAccount::LEN);

    Fixture {
        svm,
        payer,
        mint_authority,
        owner_a,
        owner_b,
        mint,
        token_a,
        token_b,
    }
}

fn data(svm: &LiteSVM, address: Address) -> Vec<u8> {
    svm.get_account(&address)
        .expect("account must exist")
        .data
}

fn mint_state(svm: &LiteSVM, address: Address) -> Mint {
    Mint::unpack(&data(svm, address)).expect("an initialized 82-byte SPL Mint")
}

fn token_state(svm: &LiteSVM, address: Address) -> TokenAccount {
    TokenAccount::unpack(&data(svm, address)).expect("an initialized 165-byte SPL Account")
}

/// Submits one instruction and returns the compute units consumed on success.
fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    signers: &[&Keypair],
) -> Result<u64, String> {
    assert_eq!(
        instruction.program_id, TOKEN_PROGRAM_ID,
        "every submitted instruction must target the canonical Tokenkeg public key"
    );
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let transaction = Transaction::new(signers, message, blockhash);
    svm.send_transaction(transaction)
        .map(|meta| meta.compute_units_consumed)
        .map_err(|failed| format!("{:?} | {}", failed.err, failed.meta.pretty_logs()))
}

fn initialize_mint(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: Address,
    authority: &Keypair,
) -> Result<u64, String> {
    let ix =
        token_ix::initialize_mint2(&TOKEN_PROGRAM_ID, &mint, &authority.pubkey(), None, DECIMALS)
            .expect("builder");
    send(svm, payer, ix, &[payer])
}

fn initialize_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    account: Address,
    mint: Address,
    owner: &Keypair,
) -> Result<u64, String> {
    let ix = token_ix::initialize_account3(&TOKEN_PROGRAM_ID, &account, &mint, &owner.pubkey())
        .expect("builder");
    send(svm, payer, ix, &[payer])
}

fn mint_tokens(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: Address,
    destination: Address,
    authority: &Keypair,
    amount: u64,
) -> Result<u64, String> {
    let ix = token_ix::mint_to(
        &TOKEN_PROGRAM_ID,
        &mint,
        &destination,
        &authority.pubkey(),
        &[],
        amount,
    )
    .expect("builder");
    send(svm, payer, ix, &[payer, authority])
}

fn transfer_tokens(
    svm: &mut LiteSVM,
    payer: &Keypair,
    source: Address,
    destination: Address,
    authority: &Keypair,
    amount: u64,
) -> Result<u64, String> {
    let ix = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &source,
        &destination,
        &authority.pubkey(),
        &[],
        amount,
    )
    .expect("builder");
    send(svm, payer, ix, &[payer, authority])
}

/// `fresh` plus an initialized mint and two initialized token accounts.
fn bootstrapped() -> Fixture {
    let mut fx = fresh();
    initialize_mint(&mut fx.svm, &fx.payer, fx.mint, &fx.mint_authority).expect("InitializeMint2");
    initialize_account(&mut fx.svm, &fx.payer, fx.token_a, fx.mint, &fx.owner_a)
        .expect("InitializeAccount3 A");
    initialize_account(&mut fx.svm, &fx.payer, fx.token_b, fx.mint, &fx.owner_b)
        .expect("InitializeAccount3 B");
    fx
}

/// `bootstrapped` plus `MINT_AMOUNT` minted into token account A.
fn funded() -> Fixture {
    let mut fx = bootstrapped();
    mint_tokens(
        &mut fx.svm,
        &fx.payer,
        fx.mint,
        fx.token_a,
        &fx.mint_authority,
        MINT_AMOUNT,
    )
    .expect("MintTo");
    fx
}

fn snapshot(fx: &Fixture) -> [Vec<u8>; 3] {
    [
        data(&fx.svm, fx.mint),
        data(&fx.svm, fx.token_a),
        data(&fx.svm, fx.token_b),
    ]
}

fn assert_unchanged(fx: &Fixture, before: &[Vec<u8>; 3]) {
    assert_eq!(
        data(&fx.svm, fx.mint),
        before[0],
        "mint data must be unchanged"
    );
    assert_eq!(
        data(&fx.svm, fx.token_a),
        before[1],
        "token account A data must be unchanged"
    );
    assert_eq!(
        data(&fx.svm, fx.token_b),
        before[2],
        "token account B data must be unchanged"
    );
}

#[test]
fn tokenkeg_is_present_executable_and_the_target_of_every_instruction() {
    let svm = LiteSVM::new();
    let program = svm
        .get_account(&TOKEN_PROGRAM_ID)
        .expect("LiteSVM::new() must install the canonical Tokenkeg program");
    assert!(
        program.executable,
        "the Tokenkeg program account must be executable"
    );

    let authority = Address::new_unique();
    let built = [
        token_ix::initialize_mint2(
            &TOKEN_PROGRAM_ID,
            &Address::new_unique(),
            &authority,
            None,
            DECIMALS,
        )
        .unwrap(),
        token_ix::initialize_account3(
            &TOKEN_PROGRAM_ID,
            &Address::new_unique(),
            &Address::new_unique(),
            &authority,
        )
        .unwrap(),
        token_ix::mint_to(
            &TOKEN_PROGRAM_ID,
            &Address::new_unique(),
            &Address::new_unique(),
            &authority,
            &[],
            1,
        )
        .unwrap(),
        token_ix::transfer(
            &TOKEN_PROGRAM_ID,
            &Address::new_unique(),
            &Address::new_unique(),
            &authority,
            &[],
            1,
        )
        .unwrap(),
    ];
    for instruction in &built {
        assert_eq!(
            instruction.program_id, TOKEN_PROGRAM_ID,
            "must target the canonical Tokenkeg public key"
        );
        assert_eq!(
            instruction.program_id,
            spl_token_interface::id(),
            "and only that key"
        );
    }
}

#[test]
fn instruction_encodings_match_the_official_legacy_layout() {
    let authority = Address::new_unique();
    let mint = Address::new_unique();
    let account = Address::new_unique();

    let ix =
        token_ix::initialize_mint2(&TOKEN_PROGRAM_ID, &mint, &authority, None, DECIMALS).unwrap();
    let mut expected = vec![20u8, DECIMALS];
    expected.extend_from_slice(&authority.to_bytes());
    expected.push(0); // freeze authority: None
    assert_eq!(
        ix.data, expected,
        "InitializeMint2 = [20, decimals, mint_authority, freeze_option]"
    );
    assert_eq!(ix.accounts.len(), 1);
    assert!(ix.accounts[0].is_writable && !ix.accounts[0].is_signer);

    let ix = token_ix::initialize_account3(&TOKEN_PROGRAM_ID, &account, &mint, &authority).unwrap();
    let mut expected = vec![18u8];
    expected.extend_from_slice(&authority.to_bytes());
    assert_eq!(ix.data, expected, "InitializeAccount3 = [18, owner]");
    assert_eq!(ix.accounts.len(), 2);
    assert!(ix.accounts[0].is_writable && !ix.accounts[1].is_writable);

    let ix = token_ix::mint_to(&TOKEN_PROGRAM_ID, &mint, &account, &authority, &[], 7).unwrap();
    let mut expected = vec![7u8];
    expected.extend_from_slice(&7u64.to_le_bytes());
    assert_eq!(ix.data, expected, "MintTo = [7, amount_le]");
    assert_eq!(ix.accounts.len(), 3);
    assert!(
        ix.accounts[0].is_writable && ix.accounts[1].is_writable && ix.accounts[2].is_signer,
        "MintTo accounts are [writable mint, writable account, signer authority]"
    );

    let ix = token_ix::transfer(&TOKEN_PROGRAM_ID, &account, &mint, &authority, &[], 9).unwrap();
    let mut expected = vec![3u8];
    expected.extend_from_slice(&9u64.to_le_bytes());
    assert_eq!(ix.data, expected, "Transfer = [3, amount_le]");
    assert_eq!(ix.accounts.len(), 3);
    assert!(
        ix.accounts[0].is_writable && ix.accounts[1].is_writable && ix.accounts[2].is_signer,
        "Transfer accounts are [writable source, writable destination, signer authority]"
    );
}

#[test]
fn initialization_produces_the_expected_mint_and_account_state() {
    let fx = bootstrapped();

    let mint = mint_state(&fx.svm, fx.mint);
    assert!(mint.is_initialized, "mint must be initialized");
    assert_eq!(mint.decimals, DECIMALS);
    assert_eq!(mint.mint_authority, COption::Some(fx.mint_authority.pubkey()));
    assert_eq!(
        mint.freeze_authority,
        COption::None,
        "no freeze authority was requested"
    );
    assert_eq!(mint.supply, 0);

    let a = token_state(&fx.svm, fx.token_a);
    assert_eq!(a.mint, fx.mint);
    assert_eq!(a.owner, fx.owner_a.pubkey());
    assert_eq!(a.amount, 0);
    assert_eq!(a.state, AccountState::Initialized);

    let b = token_state(&fx.svm, fx.token_b);
    assert_eq!(b.mint, fx.mint);
    assert_eq!(b.owner, fx.owner_b.pubkey());
    assert_eq!(b.amount, 0);
    assert_eq!(b.state, AccountState::Initialized);

    for address in [fx.mint, fx.token_a, fx.token_b] {
        let account = fx.svm.get_account(&address).unwrap();
        assert_eq!(
            account.owner, TOKEN_PROGRAM_ID,
            "Tokenkeg must own the account"
        );
        assert!(!account.executable, "data accounts must not be executable");
        assert!(
            account.lamports >= fx.svm.minimum_balance_for_rent_exemption(account.data.len()),
            "accounts must remain rent-exempt"
        );
    }
}

#[test]
fn mint_to_increases_supply_and_only_the_target_balance() {
    let mut fx = bootstrapped();
    let cu = mint_tokens(
        &mut fx.svm,
        &fx.payer,
        fx.mint,
        fx.token_a,
        &fx.mint_authority,
        MINT_AMOUNT,
    )
    .expect("MintTo signed by the mint authority");
    assert!(cu > 0, "MintTo must consume compute units, got {cu}");
    eprintln!("MintTo compute units: {cu}");

    assert_eq!(
        mint_state(&fx.svm, fx.mint).supply,
        MINT_AMOUNT,
        "supply increases by exactly the minted amount"
    );
    assert_eq!(
        token_state(&fx.svm, fx.token_a).amount,
        MINT_AMOUNT,
        "target balance increases exactly"
    );
    assert_eq!(
        token_state(&fx.svm, fx.token_b).amount,
        0,
        "the other account is untouched"
    );
}

#[test]
fn transfer_moves_balance_without_changing_supply() {
    let mut fx = funded();
    let supply_before = mint_state(&fx.svm, fx.mint).supply;
    let a_before = token_state(&fx.svm, fx.token_a).amount;
    let b_before = token_state(&fx.svm, fx.token_b).amount;

    let cu = transfer_tokens(
        &mut fx.svm,
        &fx.payer,
        fx.token_a,
        fx.token_b,
        &fx.owner_a,
        TRANSFER_AMOUNT,
    )
    .expect("Transfer signed by owner A");
    assert!(cu > 0, "Transfer must consume compute units, got {cu}");
    eprintln!("Transfer compute units: {cu}");

    assert_eq!(
        token_state(&fx.svm, fx.token_a).amount,
        a_before - TRANSFER_AMOUNT
    );
    assert_eq!(
        token_state(&fx.svm, fx.token_b).amount,
        b_before + TRANSFER_AMOUNT
    );
    assert_eq!(
        mint_state(&fx.svm, fx.mint).supply,
        supply_before,
        "supply must not change on transfer"
    );
}

#[test]
fn rejected_instructions_leave_the_token_state_byte_for_byte_unchanged() {
    let mut fx = funded();
    let attacker = Keypair::new();
    fx.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    // A second, legitimate mint/account pair, so the "wrong token-account mint"
    // case reaches the program's MintMismatch check instead of a length error.
    let other_mint = Address::new_unique();
    let other_account = Address::new_unique();
    install(&mut fx.svm, other_mint, Mint::LEN);
    install(&mut fx.svm, other_account, TokenAccount::LEN);
    initialize_mint(&mut fx.svm, &fx.payer, other_mint, &fx.mint_authority)
        .expect("second InitializeMint2");
    initialize_account(
        &mut fx.svm,
        &fx.payer,
        other_account,
        other_mint,
        &fx.owner_a,
    )
    .expect("second InitializeAccount3");
    let other_mint_before = data(&fx.svm, other_mint);
    let other_account_before = data(&fx.svm, other_account);

    // An uninitialized, Tokenkeg-owned mint/account for the uninitialized cases.
    let ghost_mint = Address::new_unique();
    let ghost_account = Address::new_unique();
    install(&mut fx.svm, ghost_mint, Mint::LEN);
    install(&mut fx.svm, ghost_account, TokenAccount::LEN);
    let ghost_mint_before = data(&fx.svm, ghost_mint);
    let ghost_account_before = data(&fx.svm, ghost_account);

    let before = snapshot(&fx);
    let supply_before = mint_state(&fx.svm, fx.mint).supply;

    // 1. MintTo signed by an authority that does not match the mint.
    let wrong_mint_authority =
        token_ix::mint_to(&TOKEN_PROGRAM_ID, &fx.mint, &fx.token_a, &attacker.pubkey(), &[], 1)
            .unwrap();
    assert!(
        send(
            &mut fx.svm,
            &fx.payer,
            wrong_mint_authority,
            &[&fx.payer, &attacker]
        )
        .is_err(),
        "a mint authority that does not match the mint must be rejected"
    );
    assert_unchanged(&fx, &before);

    // 2. Transfer signed by an authority that does not own the source.
    let wrong_transfer_authority = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &fx.token_a,
        &fx.token_b,
        &attacker.pubkey(),
        &[],
        1,
    )
    .unwrap();
    assert!(
        send(
            &mut fx.svm,
            &fx.payer,
            wrong_transfer_authority,
            &[&fx.payer, &attacker]
        )
        .is_err(),
        "a transfer authority that does not own the source must be rejected"
    );
    assert_unchanged(&fx, &before);

    // 3. Missing required signature: the authority account is present but is not
    //    a signer, so the program -- not the transaction verifier -- refuses.
    let mut unsigned_mint = token_ix::mint_to(
        &TOKEN_PROGRAM_ID,
        &fx.mint,
        &fx.token_a,
        &fx.mint_authority.pubkey(),
        &[],
        1,
    )
    .unwrap();
    unsigned_mint.accounts[2].is_signer = false;
    assert!(
        send(&mut fx.svm, &fx.payer, unsigned_mint, &[&fx.payer]).is_err(),
        "a mint authority that did not sign must be rejected"
    );
    assert_unchanged(&fx, &before);

    let mut unsigned_transfer = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &fx.token_a,
        &fx.token_b,
        &fx.owner_a.pubkey(),
        &[],
        1,
    )
    .unwrap();
    unsigned_transfer.accounts[2].is_signer = false;
    assert!(
        send(&mut fx.svm, &fx.payer, unsigned_transfer, &[&fx.payer]).is_err(),
        "a source owner that did not sign must be rejected"
    );
    assert_unchanged(&fx, &before);

    // 4. Insufficient token balance.
    let overdraft = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &fx.token_a,
        &fx.token_b,
        &fx.owner_a.pubkey(),
        &[],
        MINT_AMOUNT + 1,
    )
    .unwrap();
    assert!(
        send(
            &mut fx.svm,
            &fx.payer,
            overdraft,
            &[&fx.payer, &fx.owner_a]
        )
        .is_err(),
        "a transfer larger than the source balance must be rejected"
    );
    assert_unchanged(&fx, &before);

    // 5. Initialize an account against an uninitialized (wrong) mint.
    let wrong_mint = token_ix::initialize_account3(
        &TOKEN_PROGRAM_ID,
        &ghost_account,
        &ghost_mint,
        &fx.owner_a.pubkey(),
    )
    .unwrap();
    assert!(
        send(&mut fx.svm, &fx.payer, wrong_mint, &[&fx.payer]).is_err(),
        "initializing against an uninitialized mint must be rejected"
    );
    assert_eq!(data(&fx.svm, ghost_mint), ghost_mint_before);
    assert_eq!(data(&fx.svm, ghost_account), ghost_account_before);
    assert_unchanged(&fx, &before);

    // 6. Wrong token-account mint: a transfer whose accounts belong to different
    //    mints (spl-token 3.5.0 checks source/destination mint equality).
    let mint_mismatch = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &fx.token_a,
        &other_account,
        &fx.owner_a.pubkey(),
        &[],
        1,
    )
    .unwrap();
    assert!(
        send(
            &mut fx.svm,
            &fx.payer,
            mint_mismatch,
            &[&fx.payer, &fx.owner_a]
        )
        .is_err(),
        "a transfer between accounts of different mints must be rejected"
    );
    assert_eq!(data(&fx.svm, other_mint), other_mint_before);
    assert_eq!(data(&fx.svm, other_account), other_account_before);
    assert_unchanged(&fx, &before);

    // 7. Transfer from an uninitialized account.
    let transfer_from_ghost = token_ix::transfer(
        &TOKEN_PROGRAM_ID,
        &ghost_account,
        &fx.token_b,
        &fx.owner_a.pubkey(),
        &[],
        1,
    )
    .unwrap();
    assert!(
        send(
            &mut fx.svm,
            &fx.payer,
            transfer_from_ghost,
            &[&fx.payer, &fx.owner_a]
        )
        .is_err(),
        "transferring from an uninitialized account must be rejected"
    );
    assert_eq!(data(&fx.svm, ghost_account), ghost_account_before);
    assert_unchanged(&fx, &before);

    // The supply never moved across any rejected instruction.
    assert_eq!(mint_state(&fx.svm, fx.mint).supply, supply_before);
}
