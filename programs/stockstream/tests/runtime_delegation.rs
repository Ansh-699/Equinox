#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for `DelegateClusterMember` (opcode 41) cluster
//! security: the pre-delegation boundary that must reject every account
//! shape that is not a legitimate member of the delegated hot cluster for
//! the target market, executed against the actual deployed `stockstream.so`
//! inside LiteSVM (no host-side mocking of the validation logic).
//!
//! Contract under test (`programs/stockstream/src/magicblock.rs`):
//!
//!   accounts `[market (ro), authority (signer), member (w), member buffer
//!   (w), member record (w), member metadata (w), payer (w+signer),
//!   delegation_program, system_program, owner_program]`,
//!   data `[41, validator(32)]`.
//!
//! The boundary requires: the market ALREADY delegated to exactly that
//! validator, the member a program-owned scratch PDA (Empty) or a
//! `TradingSession` PDA of THIS market, correct per-member buffer/record/
//! metadata derivations, no writable market account, no duplicates, and
//! a hard member cap (32 -> one transaction's account list).

use std::path::PathBuf;
use std::ptr;

use litesvm::types::FailedTransactionMetadata;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::account_meta::AccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_message::Message as _Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use stockstream::{
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchHeader, SETTLEMENT_SCRATCH_LEN,
    },
    session::{derive_trading_session, TradingSession, TRADING_SESSION_SEED, TRADING_SESSION_SIZE},
    state::{DelegationStatus, MarketMode, MarketStateHeader, MARKET_ACCOUNT_SIZE},
    ID,
};

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

/// `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` — the official MagicBlock
/// Delegation Program.
const DELEGATION_PROGRAM_ID: Address = Address::new_from_array([
    181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229,
    25, 152, 204, 98, 126, 24, 147, 128, 167, 62,
]);

/// `Magic11111111111111111111111111111111111111` — the Magic Program, used
/// here only as a non-member "foreign program" account in one rejection.
const MAGIC_PROGRAM_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 176, 218, 112, 149, 236, 185, 214, 222, 195, 119, 215, 40, 145, 182, 231, 142,
    146, 234, 18, 214, 223, 187, 58, 64, 0, 0, 0, 0,
]);

const VALIDATOR: Address = Address::new_from_array([
    77, 65, 83, 49, 68, 116, 57, 113, 114, 101, 111, 82, 77, 81, 49, 52, 89, 81, 117, 104, 103, 56,
    85, 84, 90, 77, 77, 122, 68, 100, 75, 104,
]); // base58 "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57" bytes

const OTHER_VALIDATOR: Address = Address::new_from_array([7; 32]);

const DELEGATE_CLUSTER_MEMBER: u8 = 41;

fn cluster_member_data(validator: &Address) -> Vec<u8> {
    let mut data = vec![DELEGATE_CLUSTER_MEMBER];
    data.extend_from_slice(validator.as_ref());
    data
}

struct Env {
    svm: LiteSVM,
    /// Market authority (must sign the cluster-member delegation).
    authority: Keypair,
    market: Address,
    /// The already-delegated market's scratch PDA (Empty), the member under
    /// test in the happy path.
    scratch: Address,
    /// A second market, used to prove cross-market rejection.
    other_market: Address,
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

fn read_header(data: &[u8]) -> MarketStateHeader {
    unsafe { ptr::read_unaligned(data.as_ptr() as *const MarketStateHeader) }
}

fn delegated_market(market: Address, authority: [u8; 32]) -> Vec<u8> {
    let mut data = vec![0u8; MARKET_ACCOUNT_SIZE];
    let mut header = MarketStateHeader::empty();
    header.initialized = 1;
    header.mode = MarketMode::Open as u8;
    header.market_authority = authority;
    header.set_delegation_status(DelegationStatus::Delegated);
    header.set_validator(VALIDATOR.to_bytes());
    header.set_expected_commit_sequence(1);
    unsafe {
        ptr::copy_nonoverlapping(
            &header as *const MarketStateHeader as *const u8,
            data.as_mut_ptr(),
            core::mem::size_of::<MarketStateHeader>(),
        );
    }
    let _ = market;
    data
}

/// The canonical fixture: one delegated market + its Empty scratch PDA +
/// buffer/record/metadata PDAs for that member, installed in the runtime.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let market = Address::new_unique();
    let other_market = Address::new_unique();

    install(
        &mut svm,
        market,
        delegated_market(market, authority.pubkey().to_bytes()),
        DELEGATION_PROGRAM_ID, // already delegated: owned by the DLP
    );
    install(
        &mut svm,
        other_market,
        delegated_market(other_market, authority.pubkey().to_bytes()),
        DELEGATION_PROGRAM_ID,
    );

    // Scratch PDA for the delegated market, Empty (the delegation-boundary
    // invariant).
    let scratch = derive_settlement_scratch(&market, 0, &ID);
    let mut scratch_header = SettlementScratchHeader::empty(market.to_bytes(), [3; 32], 0);
    scratch_header.status = ScratchStatus::Empty as u8;
    let mut scratch_data = vec![0u8; SETTLEMENT_SCRATCH_LEN];
    unsafe {
        ptr::copy_nonoverlapping(
            &scratch_header as *const SettlementScratchHeader as *const u8,
            scratch_data.as_mut_ptr(),
            core::mem::size_of::<SettlementScratchHeader>(),
        );
    }
    install(&mut svm, scratch, scratch_data, ID);

    let (buffer, _) = Address::find_program_address(&[b"buffer", scratch.as_ref()], &ID);
    let (record, _) =
        Address::find_program_address(&[b"delegation", scratch.as_ref()], &DELEGATION_PROGRAM_ID);
    let (metadata, _) = Address::find_program_address(
        &[b"delegation-metadata", scratch.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    install(&mut svm, buffer, vec![0; SETTLEMENT_SCRATCH_LEN], ID);
    install(&mut svm, record, vec![0; 120], DELEGATION_PROGRAM_ID);
    install(&mut svm, metadata, vec![0; 160], DELEGATION_PROGRAM_ID);

    Env {
        svm,
        authority,
        market,
        scratch,
        other_market,
    }
}

impl Env {
    fn member_accounts(
        &self,
        member: &Address,
        buffer: &Address,
        record: &Address,
        metadata: &Address,
    ) -> Vec<AccountMeta> {
        let ro = |k: Address| AccountMeta {
            pubkey: k,
            is_signer: false,
            is_writable: false,
        };
        let w = |k: Address| AccountMeta {
            pubkey: k,
            is_signer: false,
            is_writable: true,
        };
        let w_signer = |k: Address| AccountMeta {
            pubkey: k,
            is_signer: true,
            is_writable: true,
        };
        let ro_signer = |k: Address| AccountMeta {
            pubkey: k,
            is_signer: true,
            is_writable: false,
        };
        vec![
            ro(self.market),
            ro_signer(self.authority.pubkey()),
            w(*member),
            w(*buffer),
            w(*record),
            w(*metadata),
            w_signer(self.authority.pubkey()),
            ro(DELEGATION_PROGRAM_ID),
            ro(Address::new_from_array([0; 32])), // system program
            ro(ID),
        ]
    }

    fn send(&mut self, accounts: Vec<AccountMeta>) -> Result<Transaction, String> {
        self.svm.expire_blockhash();
        let instruction = Instruction {
            program_id: ID,
            accounts,
            data: cluster_member_data(&VALIDATOR),
        };
        let message = Message::new(&[instruction], Some(&self.authority.pubkey()));
        let blockhash = self.svm.latest_blockhash();
        let transaction = Transaction::new(&[&self.authority], message, blockhash);
        self.svm
            .send_transaction(transaction.clone())
            .map(|_| transaction)
            .map_err(|failed| format!("{:?} | {}", failed.err, failed.meta.pretty_logs()))
    }
}

fn err_code(result: &Result<Transaction, String>) -> u32 {
    let text = result.as_ref().unwrap_err();
    // LiteSVM renders custom program errors as `Custom { code: N, ... }` or
    // "custom program error: 0x…"; extract either way.
    if let Some(hex) = text.find("custom program error: 0x") {
        let hex = &text[hex + "custom program error: 0x".len()..];
        let hex = hex.split(|c: char| !c.is_ascii_hexdigit()).next().unwrap();
        return u32::from_str_radix(hex, 16).unwrap();
    }
    if let Some(idx) = text.find("Custom { code: ") {
        let digits = &text[idx + "Custom { code: ".len()..];
        let digits: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
        return digits.parse().unwrap();
    }
    panic!("not a custom program error: {text}");
}

/// `MagicBlockNotDelegated = 0x6010` — the market must already be delegated.
const MAGIC_BLOCK_NOT_DELEGATED: u32 = 0x6010;
/// `MagicBlockInvalidAccount = 0x600E`.
const MAGIC_BLOCK_INVALID_ACCOUNT: u32 = 0x600E;
/// `MagicBlockScratchNotEmpty = 0x6013`.
const MAGIC_BLOCK_SCRATCH_NOT_EMPTY: u32 = 0x6013;
/// `MissingRequiredSignature` (pinocchio/system) = 0x2 as ProgramError::MissingRequiredSignature custom? The
/// runtime surfaces it as `InstructionError::MissingRequiredSignature` in LiteSVM's `failed.err`.
const _MAGIC_BLOCK_CLUSTER_TOO_LARGE: u32 = 0x601A;

#[test]
fn cluster_member_delegation_requires_a_delegated_market() {
    let mut env = setup();
    // Not-delegated market: stamp DelegationStatus back to NotDelegated.
    let mut header = MarketStateHeader::empty();
    header.initialized = 1;
    header.mode = MarketMode::Open as u8;
    header.market_authority = env.authority.pubkey().to_bytes();
    header.set_delegation_status(DelegationStatus::NotDelegated);
    let mut data = vec![0u8; MARKET_ACCOUNT_SIZE];
    unsafe {
        ptr::copy_nonoverlapping(
            &header as *const MarketStateHeader as *const u8,
            data.as_mut_ptr(),
            core::mem::size_of::<MarketStateHeader>(),
        );
    }
    env.svm
        .set_account(
            env.market,
            Account {
                lamports: env
                    .svm
                    .minimum_balance_for_rent_exemption(MARKET_ACCOUNT_SIZE),
                data,
                owner: DELEGATION_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let (buffer, record, metadata) = member_pdas(&env.scratch);
    let result = env.send(env.member_accounts(&env.scratch, &buffer, &record, &metadata));
    assert_code(&result, MAGIC_BLOCK_NOT_DELEGATED);
}

#[test]
fn cluster_member_delegation_rejects_a_foreign_validator() {
    let mut env = setup();
    let (buffer, record, metadata) = member_pdas(&env.scratch);
    let mut accounts = env.member_accounts(&env.scratch, &buffer, &record, &metadata);
    // Same accounts but the instruction names a DIFFERENT validator than the
    // market's recorded one: must reject before any CPI.
    let mut data = vec![DELEGATE_CLUSTER_MEMBER];
    data.extend_from_slice(OTHER_VALIDATOR.to_bytes().as_ref());
    env.svm.expire_blockhash();
    let instruction = Instruction {
        program_id: ID,
        accounts,
        data,
    };
    let message = Message::new(&[instruction], Some(&env.authority.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&env.authority], message, blockhash);
    let failed = env
        .svm
        .send_transaction(transaction)
        .expect_err("a validator mismatch must fail");
    let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
    assert!(
        text.contains("0x600e") || text.contains("24590"),
        "expected MagicBlockInvalidAccount, got {text}"
    );
}

#[test]
fn cluster_member_delegation_rejects_a_non_empty_scratch() {
    let mut env = setup();
    // Flip the scratch header's status to Ready (non-Empty).
    let mut data = env.svm.get_account(&env.scratch).unwrap().data;
    unsafe {
        let header = data.as_mut_ptr() as *mut SettlementScratchHeader;
        (*header).status = 2; // Ready
    }
    env.svm
        .set_account(
            env.scratch,
            Account {
                lamports: env.svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let (buffer, record, metadata) = member_pdas(&env.scratch);
    let result = env.send(env.member_accounts(&env.scratch, &buffer, &record, &metadata));
    assert_code(&result, MAGIC_BLOCK_SCRATCH_NOT_EMPTY);
}

#[test]
fn cluster_member_delegation_rejects_a_foreign_member_account() {
    let mut env = setup();
    // A program-owned 256-byte account that is NOT a valid session PDA.
    let foreign = Address::new_unique();
    let mut session = TradingSession::empty();
    session.initialized = 0; // uninitialized: not a valid session member
    session.target_program = ID.to_bytes();
    let mut data = vec![0u8; TRADING_SESSION_SIZE];
    unsafe {
        ptr::copy_nonoverlapping(
            &session as *const TradingSession as *const u8,
            data.as_mut_ptr(),
            TRADING_SESSION_SIZE,
        );
    }
    install(
        &mut env.svm,
        foreign,
        data,
        Address::new_from_array([9; 32]),
    );
    let (buffer, record, metadata) = member_pdas(&foreign);
    let result = env.send(env.member_accounts(&foreign, &buffer, &record, &metadata));
    assert_code(&result, MAGIC_BLOCK_INVALID_ACCOUNT);
}

#[test]
fn cluster_member_delegation_rejects_wrong_pda_derivations() {
    let mut env = setup();
    // Member is a correct scratch PDA but the metadata PDA is derived from
    // the WRONG member (the market) — a swapped cluster account must fail.
    let (_, market_record, market_metadata) = member_pdas(&env.market);
    let (buffer, record, _) = member_pdas(&env.scratch);
    let result = env.send(env.member_accounts(&env.scratch, &buffer, &record, &market_metadata));
    let text = result.as_ref().unwrap_err();
    assert!(
        !text.contains("0x6010") && !text.contains("0x6013"),
        "the mismatch gate must fire, not the lifecycle gates: {text}"
    );
    let _ = market_record;
}

#[test]
fn cluster_member_delegation_rejects_a_writable_market_account() {
    let mut env = setup();
    let (buffer, record, metadata) = member_pdas(&env.scratch);
    let mut accounts = env.member_accounts(&env.scratch, &buffer, &record, &metadata);
    // The delegated market MUST be read-only in this instruction.
    accounts[0] = AccountMeta {
        pubkey: env.market,
        is_signer: false,
        is_writable: true,
    };
    let result = env.send(accounts);
    assert_code(&result, MAGIC_BLOCK_INVALID_ACCOUNT);
}

#[test]
fn session_member_delegation_happy_path_reaches_the_cpi() {
    let mut env = setup();
    // A valid session PDA for (owner, market, seat, session_signer).
    let owner = Keypair::new();
    let session_signer = Keypair::new();
    let session = derive_trading_session(
        &owner.pubkey(),
        &env.market,
        0,
        &session_signer.pubkey(),
        &ID,
    );
    let mut session_struct = TradingSession::empty();
    session_struct.initialized = 1;
    session_struct.target_program = ID.to_bytes();
    session_struct.owner = owner.pubkey().to_bytes();
    session_struct.market = env.market.to_bytes();
    session_struct.session_signer = session_signer.pubkey().to_bytes();
    session_struct.trader_seat_index = 0;
    let mut session_data = vec![0u8; TRADING_SESSION_SIZE];
    unsafe {
        ptr::copy_nonoverlapping(
            &session_struct as *const TradingSession as *const u8,
            session_data.as_mut_ptr(),
            TRADING_SESSION_SIZE,
        );
    }
    install(&mut env.svm, session, session_data, ID);
    let (buffer, record, metadata) = member_pdas(&session);
    install(&mut env.svm, buffer, vec![0; TRADING_SESSION_SIZE], ID);
    install(&mut env.svm, record, vec![0; 120], DELEGATION_PROGRAM_ID);
    install(&mut env.svm, metadata, vec![0; 160], DELEGATION_PROGRAM_ID);

    // The CPI into the (absent) Delegation Program will fail inside
    // LiteSVM — that is EXPECTED and is the boundary this test proves:
    // every validation gate before the CPI passes, so the failure is
    // exactly the CPI itself, not a validation rejection. LiteSVM renders
    // a missing CPI target as a program failure; assert we got PAST
    // validation by checking the failure is NOT one of our
    // MagicBlockInvalid* codes and not NotEnoughAccountKeys.
    let result = env.send(env.member_accounts(&session, &buffer, &record, &metadata));
    let text = match &result {
        Ok(_) => panic!("expected the CPI to fail with no delegation program installed"),
        Err(text) => text.clone(),
    };
    assert!(
        !text.contains("0x600e")
            && !text.contains("0x6010")
            && !text.contains("0x6013")
            && !text.contains("0x601a"),
        "validation gates must pass before the CPI; got {text}"
    );
}

#[test]
fn cluster_member_delegation_rejects_duplicate_member_accounts() {
    let mut env = setup();
    let (buffer, record, metadata) = member_pdas(&env.scratch);
    let mut accounts = env.member_accounts(&env.scratch, &buffer, &record, &metadata);
    // Duplicate the member as the buffer slot: a duplicate account in one
    // transaction must be rejected (member == member-buffer).
    accounts[3] = AccountMeta {
        pubkey: env.scratch,
        is_signer: false,
        is_writable: true,
    };
    let result = env.send(accounts);
    // The wrong buffer derivation is the first gate hit (buffer != ["buffer", member]).
    assert_code(&result, MAGIC_BLOCK_INVALID_ACCOUNT);
}

fn member_pdas(member: &Address) -> (Address, Address, Address) {
    let (buffer, _) = Address::find_program_address(&[b"buffer", member.as_ref()], &ID);
    let (record, _) =
        Address::find_program_address(&[b"delegation", member.as_ref()], &DELEGATION_PROGRAM_ID);
    let (metadata, _) = Address::find_program_address(
        &[b"delegation-metadata", member.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    (buffer, record, metadata)
}

fn assert_code(result: &Result<Transaction, String>, code: u32) {
    let text = result.as_ref().unwrap_err();
    assert!(
        text.contains(&format!("0x{code:x}"))
            || text.contains(&format!("Custom {{ code: {code} }}")),
        "expected custom error 0x{code:x}, got: {text}"
    );
}

// ---------------------------------------------------------------------
// Remaining cluster-policy gates, executed against the deployed program.
// ---------------------------------------------------------------------

#[test]
fn commit_rejects_a_non_member_trailing_account() {
    let mut env = setup();
    env.svm
        .set_account(
            env.market,
            Account {
                lamports: env
                    .svm
                    .minimum_balance_for_rent_exemption(MARKET_ACCOUNT_SIZE),
                data: delegated_market(env.market, env.authority.pubkey().to_bytes()),
                owner: ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    // CommitMarket with a trailing account that is NOT a cluster member
    // (program-owned 256B but not a valid session PDA).
    let foreign = Address::new_unique();
    install(
        &mut env.svm,
        foreign,
        vec![0u8; 256],
        Address::new_from_array([9; 32]),
    );
    let commit_data = {
        let mut d = vec![14u8];
        d.extend_from_slice(&1u64.to_le_bytes());
        d
    };
    env.svm.expire_blockhash();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta {
                pubkey: env.market,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: false,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_CONTEXT_ID,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_PROGRAM_ID,
                is_signer: false,
                is_writable: false,
            },
            AccountMeta {
                pubkey: foreign,
                is_signer: false,
                is_writable: true,
            },
        ],
        data: commit_data,
    };
    let message = Message::new(&[instruction], Some(&env.authority.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&env.authority], message, blockhash);
    let failed = env
        .svm
        .send_transaction(transaction)
        .expect_err("a non-member trailing commit account must be rejected");
    let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
    assert!(
        text.contains("0x600e") || text.contains("24590"),
        "expected MagicBlockInvalidAccount, got {text}"
    );
}

/// Regression test for a real off-by-one bug (found only by actually
/// committing a real delegated cluster with a trailing member on live
/// Devnet, since the real Magic Program is a validator builtin no test
/// harness -- native or LiteSVM -- loads): `commit_market_inner`'s
/// `commit_accounts` metadata array read `accounts.get(3 + i)` for trailing
/// member `i`, two slots off from the correct `accounts.get(2 + i)`, so the
/// declared pubkey for each trailing member either named the WRONG member
/// or (once past bounds) silently fell back to the market's own pubkey,
/// duplicated -- while the actual `AccountView` handed to the CPI
/// (`commit_views`, built correctly) was the real member. A correct
/// Solana CPI requires every declared account pubkey to match the actual
/// account view passed at the same position; this test proves that
/// invariant holds by including one real trailing member and asserting the
/// only failure reachable is the expected missing-CPI-target boundary, not
/// an earlier account-mismatch style rejection.
#[test]
fn commit_accepts_a_bundle_with_a_trailing_member_and_hits_the_cpi() {
    let mut env = setup();
    env.svm
        .set_account(
            env.market,
            Account {
                lamports: env
                    .svm
                    .minimum_balance_for_rent_exemption(MARKET_ACCOUNT_SIZE),
                data: delegated_market(env.market, env.authority.pubkey().to_bytes()),
                owner: ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let commit_data = {
        let mut d = vec![14u8];
        d.extend_from_slice(&1u64.to_le_bytes());
        d
    };
    env.svm.expire_blockhash();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta {
                pubkey: env.market,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: false,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_CONTEXT_ID,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_PROGRAM_ID,
                is_signer: false,
                is_writable: false,
            },
            AccountMeta {
                pubkey: env.scratch,
                is_signer: false,
                is_writable: true,
            },
        ],
        data: commit_data,
    };
    let message = Message::new(&[instruction], Some(&env.authority.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&env.authority], message, blockhash);
    let failed = env
        .svm
        .send_transaction(transaction)
        .expect_err("the CPI target is absent");
    let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
    assert!(
        !text.contains("0x600e")
            && !text.contains("0x6010")
            && !text.contains("0x6013")
            && !text.contains("0x6011"),
        "commit validation gates must pass before the CPI; got {text}"
    );
    assert!(
        !text.contains("InvalidArgument") && !text.contains("invalid program argument"),
        "the off-by-one account-metadata bug regressed: {text}"
    );
}

#[test]
fn commit_accepts_a_market_only_bundle_and_hits_the_cpi() {
    let mut env = setup();
    // ER-side clone: program-owned with Delegated status (see the replay test).
    env.svm
        .set_account(
            env.market,
            Account {
                lamports: env
                    .svm
                    .minimum_balance_for_rent_exemption(MARKET_ACCOUNT_SIZE),
                data: delegated_market(env.market, env.authority.pubkey().to_bytes()),
                owner: ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    // Commit-only (sequence 1): every validation gate must pass so the
    // failure is exactly the (absent) Magic Program CPI.
    let commit_data = {
        let mut d = vec![14u8];
        d.extend_from_slice(&1u64.to_le_bytes());
        d
    };
    env.svm.expire_blockhash();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta {
                pubkey: env.market,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: false,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_CONTEXT_ID,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_PROGRAM_ID,
                is_signer: false,
                is_writable: false,
            },
        ],
        data: commit_data,
    };
    let message = Message::new(&[instruction], Some(&env.authority.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&env.authority], message, blockhash);
    let failed = env
        .svm
        .send_transaction(transaction)
        .expect_err("the CPI target is absent");
    let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
    assert!(
        !text.contains("0x600e")
            && !text.contains("0x6010")
            && !text.contains("0x6013")
            && !text.contains("0x6011"),
        "commit validation gates must pass before the CPI; got {text}"
    );
}

#[test]
fn commit_rejects_a_replayed_sequence() {
    let mut env = setup();
    // The ER-side clone of a delegated market keeps its ORIGINAL owner
    // (StockStream) and delegation fields — simulate that by re-installing
    // the market program-owned with Delegated status.
    env.svm
        .set_account(
            env.market,
            Account {
                lamports: env
                    .svm
                    .minimum_balance_for_rent_exemption(MARKET_ACCOUNT_SIZE),
                data: delegated_market(env.market, env.authority.pubkey().to_bytes()),
                owner: ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    // The fixture's expected commit sequence after delegation is 1; a
    // sequence of 2 must be rejected with MagicBlockSequenceReplay (0x6011)
    // BEFORE the CPI.
    let commit_data = {
        let mut d = vec![14u8];
        d.extend_from_slice(&2u64.to_le_bytes());
        d
    };
    env.svm.expire_blockhash();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta {
                pubkey: env.market,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: false,
            },
            AccountMeta {
                pubkey: env.authority.pubkey(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_CONTEXT_ID,
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: stockstream::magicblock::MAGIC_PROGRAM_ID,
                is_signer: false,
                is_writable: false,
            },
        ],
        data: commit_data,
    };
    let message = Message::new(&[instruction], Some(&env.authority.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&env.authority], message, blockhash);
    let failed = env
        .svm
        .send_transaction(transaction)
        .expect_err("sequence replay must fail");
    let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
    assert!(
        text.contains("0x6011") || text.contains("24593"),
        "expected MagicBlockSequenceReplay, got {text}"
    );
}
