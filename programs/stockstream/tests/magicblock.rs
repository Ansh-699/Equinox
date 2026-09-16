//! MagicBlock CPI construction: golden-vector byte verification and
//! account-validation failure coverage.
//!
//! `pinocchio::cpi::invoke_signed` is a no-op off the `solana`/`bpf` target
//! (see `solana-instruction-view`'s `cpi.rs`), so a host `cargo test` cannot
//! observe an actual delegation-program or Magic-program execution, and a
//! "successful" end-to-end run here would not prove anything (the buffer
//! never gets copied back into the market account the way the real
//! delegation program does it). What *is* fully verifiable off-chain:
//!
//! 1. The exact bytes StockStream would send are correct -- checked by
//!    reproducing them from the real `magicblock-delegation-program-api`
//!    (`dlp_api`) and `magicblock-magic-program-api` crates' own
//!    `borsh`/`bincode` serialization (golden vectors).
//! 2. Every account-shape/lifecycle validation that runs *before* the CPI is
//!    reachable and correct (missing/duplicate/wrong-program/wrong-PDA
//!    accounts, non-Empty scratch, replayed/skipped sequence, invalid
//!    lifecycle transitions, forged/malformed callback data).
//!
//! Per the implementation brief: this is unit-tested, not SBF-runtime
//! verified.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    error::StockStreamError,
    magicblock::{
        commit_and_undelegate_market, commit_market, delegate_market,
        encode_delegate_instruction_data, encode_market_delegate_seeds, external_undelegate,
        COMMIT_INTERVAL_MS, DELEGATE_BUFFER_TAG, DELEGATE_INSTRUCTION_DATA_LEN,
        DELEGATION_METADATA_TAG, DELEGATION_PROGRAM_ID, DELEGATION_RECORD_TAG,
        EXTERNAL_UNDELEGATE_DATA_LEN, EXTERNAL_UNDELEGATE_DISCRIMINATOR, MAGIC_CONTEXT_ID,
        MAGIC_PROGRAM_ID, SCHEDULE_COMMIT_AND_UNDELEGATE_DATA, SCHEDULE_COMMIT_DATA,
        UNDELEGATE_BUFFER_TAG,
    },
    registry::{derive_perp_market, PERP_MARKET_SEED},
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchHeader, SETTLEMENT_SCRATCH_LEN,
    },
    state::{DelegationStatus, MarketStateHeader, MARKET_ACCOUNT_SIZE},
    ID,
};

// ---------------------------------------------------------------------
// Golden vectors: our no-alloc, hand-rolled encoders must byte-match the
// real crates' own serializers.
// ---------------------------------------------------------------------

#[test]
fn delegate_instruction_data_matches_real_borsh_delegate_args() {
    use dlp_api::compat::borsh::BorshSerialize;

    let instrument = Address::new_from_array([7; 32]);
    let validator = Address::new_from_array([9; 32]);

    let ours = encode_delegate_instruction_data(&instrument, &validator);
    assert_eq!(ours.len(), DELEGATE_INSTRUCTION_DATA_LEN);

    let mut expected = 0u64.to_le_bytes().to_vec(); // DlpDiscriminator::Delegate == 0
    let args = dlp_api::args::DelegateArgs {
        commit_frequency_ms: COMMIT_INTERVAL_MS,
        seeds: vec![PERP_MARKET_SEED.to_vec(), instrument.as_ref().to_vec()],
        validator: Some(dlp_api::compat::Pubkey::new_from_array(
            *validator.as_array(),
        )),
    };
    args.serialize(&mut expected).unwrap();

    assert_eq!(ours.as_slice(), expected.as_slice());
}

#[test]
fn schedule_commit_data_matches_real_bincode_instruction() {
    use magicblock_magic_program_api::args::{CommitTypeArgs, MagicIntentBundleArgs};
    use magicblock_magic_program_api::instruction::MagicBlockInstruction;

    let args = MagicIntentBundleArgs {
        commit: Some(CommitTypeArgs::Standalone(vec![2u8])),
        commit_and_undelegate: None,
        commit_finalize: None,
        commit_finalize_and_undelegate: None,
        standalone_actions: vec![],
    };
    let expected = bincode::serialize(&MagicBlockInstruction::ScheduleIntentBundle(args)).unwrap();
    assert_eq!(SCHEDULE_COMMIT_DATA.as_slice(), expected.as_slice());
}

#[test]
fn schedule_commit_and_undelegate_data_matches_real_bincode_instruction() {
    use magicblock_magic_program_api::args::{
        CommitAndUndelegateArgs, CommitTypeArgs, MagicIntentBundleArgs, UndelegateTypeArgs,
    };
    use magicblock_magic_program_api::instruction::MagicBlockInstruction;

    let args = MagicIntentBundleArgs {
        commit: None,
        commit_and_undelegate: Some(CommitAndUndelegateArgs {
            commit_type: CommitTypeArgs::Standalone(vec![2u8]),
            undelegate_type: UndelegateTypeArgs::Standalone,
        }),
        commit_finalize: None,
        commit_finalize_and_undelegate: None,
        standalone_actions: vec![],
    };
    let expected = bincode::serialize(&MagicBlockInstruction::ScheduleIntentBundle(args)).unwrap();
    assert_eq!(
        SCHEDULE_COMMIT_AND_UNDELEGATE_DATA.as_slice(),
        expected.as_slice()
    );
}

#[test]
fn undelegate_seeds_encoding_round_trips_through_the_same_encoder_used_for_delegate() {
    let instrument = Address::new_from_array([42; 32]);
    let seeds = encode_market_delegate_seeds(&instrument);
    let mut callback_data = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    callback_data.extend_from_slice(&seeds);
    assert_eq!(callback_data.len(), EXTERNAL_UNDELEGATE_DATA_LEN);
}

// ---------------------------------------------------------------------
// Program-ID / constant cross-checks against the real crates.
// ---------------------------------------------------------------------

#[test]
fn program_ids_and_discriminator_match_the_real_crates() {
    assert_eq!(
        DELEGATION_PROGRAM_ID.to_bytes(),
        dlp_api::fast::ID.to_bytes()
    );
    assert_eq!(
        MAGIC_PROGRAM_ID.to_bytes(),
        magicblock_magic_program_api::id().to_bytes()
    );
    assert_eq!(
        MAGIC_CONTEXT_ID.to_bytes(),
        magicblock_magic_program_api::MAGIC_CONTEXT_PUBKEY.to_bytes()
    );
    assert_eq!(
        EXTERNAL_UNDELEGATE_DISCRIMINATOR,
        [196, 28, 41, 206, 48, 37, 51, 167]
    );
    assert_eq!(DELEGATION_RECORD_TAG, b"delegation");
    assert_eq!(DELEGATION_METADATA_TAG, b"delegation-metadata");
    assert_eq!(DELEGATE_BUFFER_TAG, b"buffer");
    assert_eq!(UNDELEGATE_BUFFER_TAG, b"undelegate-buffer");
    assert_eq!(COMMIT_INTERVAL_MS, 30_000);
}

// ---------------------------------------------------------------------
// Account fixtures (same pattern as tests/account_settlement.rs).
// ---------------------------------------------------------------------

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

fn valid_market(instrument: Address, authority: Address, status: DelegationStatus) -> TestAccount {
    let market_key = derive_perp_market(&ID, &instrument);
    let mut market = account(market_key, ID, MARKET_ACCOUNT_SIZE, false, true);
    let mut header = MarketStateHeader::empty();
    header.initialized = 1;
    header.mode = 1; // Open
    header.market_authority = authority.to_bytes();
    header.initial_margin_bps = 2_000;
    header.maintenance_margin_bps = 1_000;
    header.maximum_leverage = 5;
    header.set_delegation_status(status);
    let bytes = unsafe { market.view.borrow_unchecked_mut() };
    bytes.fill(0);
    unsafe {
        ptr::copy_nonoverlapping(
            &header as *const MarketStateHeader as *const u8,
            bytes.as_mut_ptr(),
            size_of::<MarketStateHeader>(),
        );
    }
    market
}

fn read_header(market: &TestAccount) -> MarketStateHeader {
    let bytes = unsafe { market.view.borrow_unchecked() };
    let mut header = core::mem::MaybeUninit::<MarketStateHeader>::uninit();
    unsafe {
        ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            header.as_mut_ptr().cast::<u8>(),
            size_of::<MarketStateHeader>(),
        );
        header.assume_init()
    }
}

fn empty_scratch(market: Address, seat: u16) -> TestAccount {
    let address = derive_settlement_scratch(&market, seat, &ID);
    let mut scratch = account(address, ID, SETTLEMENT_SCRATCH_LEN, false, true);
    let mut header = SettlementScratchHeader::empty(market.to_bytes(), [3; 32], seat);
    header.status = ScratchStatus::Empty as u8;
    let bytes = unsafe { scratch.view.borrow_unchecked_mut() };
    bytes.fill(0);
    unsafe {
        ptr::copy_nonoverlapping(
            &header as *const SettlementScratchHeader as *const u8,
            bytes.as_mut_ptr(),
            size_of::<SettlementScratchHeader>(),
        );
    }
    scratch
}

fn err_code(result: pinocchio::ProgramResult) -> u32 {
    match result.unwrap_err() {
        pinocchio::error::ProgramError::Custom(code) => code,
        other => panic!("expected a custom StockStream error, got {other:?}"),
    }
}

fn delegate_market_accounts(
    market: &TestAccount,
    authority: &TestAccount,
    instrument: &TestAccount,
    payer: &TestAccount,
    buffer: &TestAccount,
    record: &TestAccount,
    metadata: &TestAccount,
    delegation_program: &TestAccount,
    system_program: &TestAccount,
    owner_program: &TestAccount,
    scratch: &[TestAccount],
) -> Vec<AccountView> {
    let mut accounts = vec![
        market.view.clone(),
        authority.view.clone(),
        instrument.view.clone(),
        payer.view.clone(),
        buffer.view.clone(),
        record.view.clone(),
        metadata.view.clone(),
        delegation_program.view.clone(),
        system_program.view.clone(),
        owner_program.view.clone(),
    ];
    accounts.extend(scratch.iter().map(|a| a.view.clone()));
    accounts
}

// ---------------------------------------------------------------------
// DelegateMarket: account/lifecycle validation (pre-CPI, fully testable).
// ---------------------------------------------------------------------

#[test]
fn delegate_market_rejects_too_few_accounts() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let mut accounts = vec![market.view.clone()];
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert!(matches!(
        result.unwrap_err(),
        pinocchio::error::ProgramError::NotEnoughAccountKeys
    ));
}

#[test]
fn delegate_market_rejects_zero_validator() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let authority = account(authority_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let buffer_key =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.view.address().as_ref()], &ID)
            .0;
    let buffer = account(buffer_key, ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let delegation_program = account(DELEGATION_PROGRAM_ID, Address::default(), 0, false, false);
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        &[],
    );
    let result = delegate_market(&ID, &mut accounts, Address::default());
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidAccount as u32
    );
}

#[test]
fn delegate_market_rejects_wrong_delegation_program_account() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let authority = account(authority_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let buffer_key =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.view.address().as_ref()], &ID)
            .0;
    let buffer = account(buffer_key, ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    // Wrong program passed where the delegation program is expected.
    let delegation_program = account(
        Address::new_from_array([99; 32]),
        Address::default(),
        0,
        false,
        false,
    );
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        &[],
    );
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidAccount as u32
    );
}

#[test]
fn delegate_market_rejects_duplicate_hot_accounts() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let authority = account(authority_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    // Buffer aliases the market account itself.
    let buffer = account(*market.view.address(), ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let delegation_program = account(DELEGATION_PROGRAM_ID, Address::default(), 0, false, false);
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        &[],
    );
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidAccount as u32
    );
}

#[test]
fn delegate_market_rejects_non_empty_settlement_scratch() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let authority = account(authority_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let buffer_key =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.view.address().as_ref()], &ID)
            .0;
    let buffer = account(buffer_key, ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let delegation_program = account(DELEGATION_PROGRAM_ID, Address::default(), 0, false, false);
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut scratch = empty_scratch(*market.view.address(), 0);
    {
        let bytes = unsafe { scratch.view.borrow_unchecked_mut() };
        bytes[11] = ScratchStatus::Planning as u8; // status byte, see scratch.rs layout
    }

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        core::slice::from_ref(&scratch),
    );
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockScratchNotEmpty as u32
    );
}

#[test]
fn delegate_market_rejects_wrong_market_authority() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    // A different signer than the one recorded on the market header.
    let impostor_key = Address::new_from_array([200; 32]);
    let authority = account(impostor_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let buffer_key =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.view.address().as_ref()], &ID)
            .0;
    let buffer = account(buffer_key, ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let delegation_program = account(DELEGATION_PROGRAM_ID, Address::default(), 0, false, false);
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        &[],
    );
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert!(matches!(
        result.unwrap_err(),
        pinocchio::error::ProgramError::MissingRequiredSignature
    ));
}

#[test]
fn delegate_market_rejects_already_delegated_market() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(instrument_key, authority_key, DelegationStatus::Delegated);
    let authority = account(authority_key, Address::default(), 0, true, false);
    let instrument = account(instrument_key, ID, 128, false, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let buffer_key =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.view.address().as_ref()], &ID)
            .0;
    let buffer = account(buffer_key, ID, 0, false, true);
    let record_key = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let record = account(record_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let metadata_key = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.view.address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let metadata = account(metadata_key, DELEGATION_PROGRAM_ID, 0, false, true);
    let delegation_program = account(DELEGATION_PROGRAM_ID, Address::default(), 0, false, false);
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);
    let owner_program = account(ID, Address::default(), 0, false, false);

    let mut accounts = delegate_market_accounts(
        &market,
        &authority,
        &instrument,
        &payer,
        &buffer,
        &record,
        &metadata,
        &delegation_program,
        &system_program,
        &owner_program,
        &[],
    );
    let result = delegate_market(&ID, &mut accounts, Address::new_from_array([5; 32]));
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockAlreadyDelegated as u32
    );
}

// ---------------------------------------------------------------------
// CommitMarket / CommitAndUndelegate: lifecycle and replay validation.
// ---------------------------------------------------------------------

fn commit_accounts(
    market: &TestAccount,
    authority: &TestAccount,
    payer: &TestAccount,
    magic_context: &TestAccount,
    magic_program: &TestAccount,
) -> Vec<AccountView> {
    vec![
        market.view.clone(),
        authority.view.clone(),
        payer.view.clone(),
        magic_context.view.clone(),
        magic_program.view.clone(),
    ]
}

#[test]
fn commit_market_rejects_when_not_delegated() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(
        instrument_key,
        authority_key,
        DelegationStatus::NotDelegated,
    );
    let authority = account(authority_key, Address::default(), 0, true, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let magic_context = account(MAGIC_CONTEXT_ID, Address::default(), 0, false, true);
    let magic_program = account(MAGIC_PROGRAM_ID, Address::default(), 0, false, false);

    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    let result = commit_market(&ID, &mut accounts, 1);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockNotDelegated as u32
    );
}

#[test]
fn commit_market_rejects_sequence_replay() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let market = valid_market(instrument_key, authority_key, DelegationStatus::Delegated);
    let authority = account(authority_key, Address::default(), 0, true, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let magic_context = account(MAGIC_CONTEXT_ID, Address::default(), 0, false, true);
    let magic_program = account(MAGIC_PROGRAM_ID, Address::default(), 0, false, false);

    // header.expected_commit_sequence() defaults to 0 from `MarketStateHeader::empty()`;
    // the correct next sequence for a freshly-delegated market is 1.
    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    let result = commit_market(&ID, &mut accounts, 0);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockSequenceReplay as u32
    );

    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    let result = commit_market(&ID, &mut accounts, 5); // skips ahead
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockSequenceReplay as u32
    );
}

#[test]
fn commit_market_succeeds_and_advances_sequence_when_invoke_is_a_noop() {
    // `invoke_signed` no-ops off-chain and returns `Ok`, so this exercises the
    // full pre/post-CPI bookkeeping path (not the actual Magic Program
    // execution, which is SBF-runtime-unverified in this environment).
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let mut market = valid_market(instrument_key, authority_key, DelegationStatus::Delegated);
    {
        let bytes = unsafe { market.view.borrow_unchecked_mut() };
        let mut header = MarketStateHeader::empty();
        unsafe {
            ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                &mut header as *mut MarketStateHeader as *mut u8,
                size_of::<MarketStateHeader>(),
            );
        }
        header.set_expected_commit_sequence(1);
        unsafe {
            ptr::copy_nonoverlapping(
                &header as *const MarketStateHeader as *const u8,
                bytes.as_mut_ptr(),
                size_of::<MarketStateHeader>(),
            );
        }
    }
    let authority = account(authority_key, Address::default(), 0, true, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let magic_context = account(MAGIC_CONTEXT_ID, Address::default(), 0, false, true);
    let magic_program = account(MAGIC_PROGRAM_ID, Address::default(), 0, false, false);

    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    commit_market(&ID, &mut accounts, 1).expect("commit should succeed");

    let header = read_header(&market);
    assert_eq!(header.last_committed_sequence(), 1);
    assert_eq!(header.expected_commit_sequence(), 2);

    // Replaying the same sequence must now be rejected.
    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    let result = commit_market(&ID, &mut accounts, 1);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockSequenceReplay as u32
    );
}

#[test]
fn commit_and_undelegate_rejects_when_already_pending() {
    let instrument_key = Address::new_from_array([1; 32]);
    let authority_key = Address::new_from_array([2; 32]);
    let mut market = valid_market(instrument_key, authority_key, DelegationStatus::Delegated);
    {
        let bytes = unsafe { market.view.borrow_unchecked_mut() };
        let mut header = MarketStateHeader::empty();
        unsafe {
            ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                &mut header as *mut MarketStateHeader as *mut u8,
                size_of::<MarketStateHeader>(),
            );
        }
        header.set_expected_commit_sequence(1);
        header.set_pending_undelegation(true);
        unsafe {
            ptr::copy_nonoverlapping(
                &header as *const MarketStateHeader as *const u8,
                bytes.as_mut_ptr(),
                size_of::<MarketStateHeader>(),
            );
        }
    }
    let authority = account(authority_key, Address::default(), 0, true, false);
    let payer = account(
        Address::new_from_array([3; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let magic_context = account(MAGIC_CONTEXT_ID, Address::default(), 0, false, true);
    let magic_program = account(MAGIC_PROGRAM_ID, Address::default(), 0, false, false);

    let mut accounts = commit_accounts(&market, &authority, &payer, &magic_context, &magic_program);
    let result = commit_and_undelegate_market(&ID, &mut accounts, 1);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockUndelegationInProgress as u32
    );
}

// ---------------------------------------------------------------------
// External-undelegate callback: forgery / replay / malformed-data rejection.
// ---------------------------------------------------------------------

fn callback_accounts(
    market: &TestAccount,
    buffer: &TestAccount,
    validator: &TestAccount,
    system_program: &TestAccount,
) -> Vec<AccountView> {
    vec![
        market.view.clone(),
        buffer.view.clone(),
        validator.view.clone(),
        system_program.view.clone(),
    ]
}

#[test]
fn external_undelegate_rejects_wrong_discriminator() {
    let instrument_key = Address::new_from_array([1; 32]);
    let market_key = derive_perp_market(&ID, &instrument_key);
    let market = account(market_key, pinocchio_system::ID, 0, false, true);
    let buffer_key = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let buffer = account(
        buffer_key,
        DELEGATION_PROGRAM_ID,
        MARKET_ACCOUNT_SIZE,
        true,
        true,
    );
    let validator = account(
        Address::new_from_array([8; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);

    let mut data = [0u8; EXTERNAL_UNDELEGATE_DATA_LEN];
    data[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]); // wrong discriminator
    let mut accounts = callback_accounts(&market, &buffer, &validator, &system_program);
    let result = external_undelegate(&ID, &mut accounts, &data);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidCallback as u32
    );
}

#[test]
fn external_undelegate_rejects_forged_buffer_that_is_not_a_signer() {
    let instrument_key = Address::new_from_array([1; 32]);
    let market_key = derive_perp_market(&ID, &instrument_key);
    let market = account(market_key, pinocchio_system::ID, 0, false, true);
    let buffer_key = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    // Correct buffer PDA address, but *not* a signer -- a forged CPI (e.g.
    // from an attacker-controlled program) cannot produce this signature.
    let buffer = account(
        buffer_key,
        DELEGATION_PROGRAM_ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
    );
    let validator = account(
        Address::new_from_array([8; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);

    let mut data = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&encode_market_delegate_seeds(&instrument_key));
    let mut accounts = callback_accounts(&market, &buffer, &validator, &system_program);
    let result = external_undelegate(&ID, &mut accounts, &data);
    assert!(matches!(
        result.unwrap_err(),
        pinocchio::error::ProgramError::MissingRequiredSignature
    ));
}

#[test]
fn external_undelegate_rejects_seeds_for_a_different_market() {
    let instrument_key = Address::new_from_array([1; 32]);
    let market_key = derive_perp_market(&ID, &instrument_key);
    let market = account(market_key, pinocchio_system::ID, 0, false, true);
    let buffer_key = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let buffer = account(
        buffer_key,
        DELEGATION_PROGRAM_ID,
        MARKET_ACCOUNT_SIZE,
        true,
        true,
    );
    let validator = account(
        Address::new_from_array([8; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);

    // Seeds for a *different* instrument -- must not be accepted for this market.
    let mut data = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&encode_market_delegate_seeds(&Address::new_from_array(
        [77; 32],
    )));
    let mut accounts = callback_accounts(&market, &buffer, &validator, &system_program);
    let result = external_undelegate(&ID, &mut accounts, &data);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidCallback as u32
    );
}

#[test]
fn external_undelegate_rejects_a_market_still_owned_by_stockstream() {
    let instrument_key = Address::new_from_array([1; 32]);
    let market_key = derive_perp_market(&ID, &instrument_key);
    // Still owned by StockStream: this account was never actually handed to
    // the delegation program's undelegate flow.
    let market = account(market_key, ID, MARKET_ACCOUNT_SIZE, false, true);
    let buffer_key = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let buffer = account(
        buffer_key,
        DELEGATION_PROGRAM_ID,
        MARKET_ACCOUNT_SIZE,
        true,
        true,
    );
    let validator = account(
        Address::new_from_array([8; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let system_program = account(pinocchio_system::ID, Address::default(), 0, false, false);

    let mut data = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&encode_market_delegate_seeds(&instrument_key));
    let mut accounts = callback_accounts(&market, &buffer, &validator, &system_program);
    let result = external_undelegate(&ID, &mut accounts, &data);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidCallback as u32
    );
}

#[test]
fn external_undelegate_rejects_wrong_system_program() {
    let instrument_key = Address::new_from_array([1; 32]);
    let market_key = derive_perp_market(&ID, &instrument_key);
    let market = account(market_key, pinocchio_system::ID, 0, false, true);
    let buffer_key = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0;
    let buffer = account(
        buffer_key,
        DELEGATION_PROGRAM_ID,
        MARKET_ACCOUNT_SIZE,
        true,
        true,
    );
    let validator = account(
        Address::new_from_array([8; 32]),
        Address::default(),
        0,
        true,
        true,
    );
    let wrong_system_program = account(
        Address::new_from_array([66; 32]),
        Address::default(),
        0,
        false,
        false,
    );

    let mut data = EXTERNAL_UNDELEGATE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&encode_market_delegate_seeds(&instrument_key));
    let mut accounts = callback_accounts(&market, &buffer, &validator, &wrong_system_program);
    let result = external_undelegate(&ID, &mut accounts, &data);
    assert_eq!(
        err_code(result),
        StockStreamError::MagicBlockInvalidAccount as u32
    );
}
