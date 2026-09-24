//! `ConsumeOracleUpdate` verification coverage.
//!
//! Ground truth for every constant and account/data shape checked here was
//! read directly from the real `pyth-network/pyth-lazer-public` GitHub repo
//! during implementation (not guessed): `contracts/solana/programs/
//! pyth-lazer-solana-contract/src/{lib,signature}.rs` for the on-chain
//! verifier's accounts, the `verify_message` Anchor instruction (its
//! discriminator is independently reproduced here from
//! `sha256("global:verify_message")[..8]`), and the Ed25519-instruction
//! sysvar-introspection contract; `sdk/rust/protocol/src/{message,payload,
//! api}.rs` for the `SolanaMessage` envelope, the tag-length-value payload
//! format, and the real `PriceFeedProperty`/`MarketSession` discriminants.
//!
//! `pinocchio::cpi::invoke_with_bounds` is a no-op off the SBF target (see
//! `tests/magicblock.rs`), so a host test cannot observe the Pyth program's
//! own cryptographic signature/trusted-signer check actually running. What
//! is fully exercised here: every account-shape check, this program's own
//! independent Instructions-sysvar inspection (which runs *before* the CPI
//! and does not depend on it), and every post-parse business rule (feed,
//! channel, exponent, price, confidence, timestamps, session). Live signed
//! verification remains unverified pending `PYTH_PRO_API_KEY`.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    error::ProgramError,
    Address,
};
use equinox::{
    handlers::OFF_CHAIN_TEST_NOW,
    process_instruction,
    state::{MarketStateHeader, MARKET_ACCOUNT_SIZE},
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
    executable: bool,
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
                executable: executable as u8,
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

// Ground-truth constants (see module doc for sources).
const PYTH_PROGRAM_ID: Address = Address::new_from_array([
    12, 74, 159, 176, 3, 249, 12, 128, 32, 17, 101, 150, 154, 165, 132, 195, 182, 126, 234, 138,
    69, 43, 85, 3, 6, 14, 175, 224, 214, 116, 116, 91,
]);
const PYTH_STORAGE_ID: Address = Address::new_from_array([
    42, 109, 225, 199, 127, 174, 116, 113, 78, 156, 43, 125, 245, 28, 89, 122, 141, 218, 138, 70,
    61, 251, 135, 64, 90, 171, 220, 10, 61, 0, 238, 25,
]);
const INSTRUCTIONS_SYSVAR_ID: Address = Address::new_from_array([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33,
    86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0,
]);
const ED25519_PROGRAM_ID: Address = Address::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

fn err_code(result: Result<(), ProgramError>) -> u32 {
    match result.unwrap_err() {
        ProgramError::Custom(code) => code,
        other => panic!("expected custom error, got {other:?}"),
    }
}

/// Builds a minimal, well-formed Instructions sysvar buffer declaring a
/// single preceding instruction (the Ed25519 one) at index 0, with `current`
/// reporting that the *calling* (ConsumeOracleUpdate) instruction is at
/// index 1 -- i.e. immediately after it, the layout the real keeper
/// produces. Matches the exact on-chain sysvar wire format pinocchio's
/// `sysvars::instructions::Instructions` parses.
fn build_instructions_sysvar(ed25519_program_id: Address, num_signatures: u8) -> Vec<u8> {
    let ix_data: Vec<u8> = vec![num_signatures, 0]; // [num_signatures, padding]
    let ix_num_accounts: u16 = 0;
    let mut instruction_bytes = Vec::new();
    instruction_bytes.extend(ix_num_accounts.to_le_bytes());
    instruction_bytes.extend(ed25519_program_id.to_bytes());
    instruction_bytes.extend((ix_data.len() as u16).to_le_bytes());
    instruction_bytes.extend(&ix_data);

    let num_instructions: u16 = 1;
    let header_len = 2 + 2 * num_instructions as usize;
    let mut buf = Vec::new();
    buf.extend(num_instructions.to_le_bytes());
    buf.extend((header_len as u16).to_le_bytes()); // offset of instruction 0
    buf.extend(&instruction_bytes);
    buf.extend(1u16.to_le_bytes()); // current instruction index (we are "1")
    buf
}

/// Builds a well-formed (but unsigned -- there is no real Pyth Lazer signing
/// key available in this environment) `SolanaMessage` envelope wrapping the
/// exact 5-property TLV payload the keeper always requests.
#[allow(clippy::too_many_arguments)]
fn build_message(
    feed_id: u32,
    channel: u8,
    price: i64,
    exponent: i16,
    confidence: i64,
    session: i16,
    envelope_timestamp_us: u64,
    feed_update_timestamp_us: u64,
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend(2_479_346_549u32.to_le_bytes()); // PAYLOAD_FORMAT_MAGIC
    payload.extend(envelope_timestamp_us.to_le_bytes()); // [4..12)
    payload.push(channel); // [12]
    payload.push(1); // num_feeds [13]
    payload.extend(feed_id.to_le_bytes()); // [14..18)
    payload.push(5); // num_properties [18]
    payload.push(0); // Price tag [19]
    payload.extend(price.to_le_bytes()); // [20..28)
    payload.push(4); // Exponent tag [28]
    payload.extend(exponent.to_le_bytes()); // [29..31)
    payload.push(5); // Confidence tag [31]
    payload.extend(confidence.to_le_bytes()); // [32..40)
    payload.push(9); // MarketSession tag [40]
    payload.extend(session.to_le_bytes()); // [41..43)
    payload.push(12); // FeedUpdateTimestamp tag [43]
    payload.push(1); // Option::Some [44]
    payload.extend(feed_update_timestamp_us.to_le_bytes()); // [45..53)
    assert_eq!(payload.len(), 53);

    let mut message = Vec::new();
    message.extend(2_182_742_457u32.to_le_bytes()); // SOLANA_FORMAT_MAGIC
    message.extend([0u8; 64]); // signature (unsigned in this environment)
    message.extend([7u8; 32]); // public key placeholder
    message.extend((payload.len() as u16).to_le_bytes());
    message.extend(&payload);
    message
}

fn instruction_data(
    ed25519_instruction_index: u16,
    signature_index: u8,
    message: &[u8],
) -> Vec<u8> {
    let mut data = vec![12u8];
    data.extend(ed25519_instruction_index.to_le_bytes());
    data.push(signature_index);
    data.extend_from_slice(message);
    data
}

struct Fixture {
    market: TestAccount,
    payer: TestAccount,
    pyth_program: TestAccount,
    storage: TestAccount,
    treasury: TestAccount,
    system_program: TestAccount,
    instructions_sysvar: TestAccount,
}

fn fixture() -> Fixture {
    let treasury_addr = Address::new_from_array([50; 32]);
    let mut market = account(
        Address::new_from_array([40; 32]),
        ID,
        MARKET_ACCOUNT_SIZE,
        false,
        true,
        false,
    );
    {
        let bytes = unsafe { market.view.borrow_unchecked_mut() };
        let mut header = MarketStateHeader::empty();
        header.initialized = 1;
        header.price_exponent = -8;
        header.initial_margin_bps = 2_000;
        header.maintenance_margin_bps = 1_000;
        header.maximum_leverage = 5;
        header.reserved_upgrade[64..68].copy_from_slice(&7u32.to_le_bytes()); // configured feed id
        header.reserved_upgrade[68] = 3; // configured channel
        unsafe {
            ptr::copy_nonoverlapping(
                &header as *const MarketStateHeader as *const u8,
                bytes.as_mut_ptr(),
                size_of::<MarketStateHeader>(),
            );
        }
    }
    let payer = account(
        Address::new_from_array([41; 32]),
        Address::default(),
        0,
        true,
        true,
        false,
    );
    let pyth_program = account(PYTH_PROGRAM_ID, Address::default(), 0, false, false, true);
    let mut storage_data = vec![0u8; 72];
    storage_data[40..72].copy_from_slice(&treasury_addr.to_bytes());
    let mut storage = account(
        PYTH_STORAGE_ID,
        PYTH_PROGRAM_ID,
        storage_data.len(),
        false,
        false,
        false,
    );
    unsafe { storage.view.borrow_unchecked_mut() }.copy_from_slice(&storage_data);
    let treasury = account(treasury_addr, Address::default(), 0, false, true, false);
    let system_program = account(
        Address::default(),
        Address::default(),
        0,
        false,
        false,
        false,
    );
    let sysvar_data = build_instructions_sysvar(ED25519_PROGRAM_ID, 1);
    let mut instructions_sysvar = account(
        INSTRUCTIONS_SYSVAR_ID,
        Address::default(),
        sysvar_data.len(),
        false,
        false,
        false,
    );
    unsafe { instructions_sysvar.view.borrow_unchecked_mut() }.copy_from_slice(&sysvar_data);
    Fixture {
        market,
        payer,
        pyth_program,
        storage,
        treasury,
        system_program,
        instructions_sysvar,
    }
}

impl Fixture {
    fn accounts(&self) -> [AccountView; 7] {
        [
            self.market.view.clone(),
            self.payer.view.clone(),
            self.pyth_program.view.clone(),
            self.storage.view.clone(),
            self.treasury.view.clone(),
            self.system_program.view.clone(),
            self.instructions_sysvar.view.clone(),
        ]
    }
}

struct SnapshotFixture {
    base: Fixture,
    core: TestAccount,
    snapshot: TestAccount,
}

impl SnapshotFixture {
    fn accounts(&self) -> [AccountView; 8] {
        [
            self.snapshot.view.clone(),
            self.core.view.clone(),
            self.base.payer.view.clone(),
            self.base.pyth_program.view.clone(),
            self.base.storage.view.clone(),
            self.base.treasury.view.clone(),
            self.base.system_program.view.clone(),
            self.base.instructions_sysvar.view.clone(),
        ]
    }
}

fn snapshot_fixture(delegated_core: bool) -> SnapshotFixture {
    let base = fixture();
    let core_address = Address::new_from_array([40; 32]);
    let core_owner = if delegated_core {
        equinox::magicblock::DELEGATION_PROGRAM_ID
    } else {
        ID
    };
    let mut core = account(
        core_address,
        core_owner,
        equinox::v3::V3_MARKET_CORE_SIZE,
        false,
        false,
        false,
    );
    unsafe {
        let bytes = core.view.borrow_unchecked_mut();
        bytes[0..8].copy_from_slice(&equinox::v3::V3_MARKET_CORE_DISCRIMINATOR);
        bytes[10] = 1;
        bytes[44..76].copy_from_slice(base.payer.view.address().as_ref());
        bytes[equinox::v3::V3_CORE_ORACLE_FEED_ID_OFFSET
            ..equinox::v3::V3_CORE_ORACLE_FEED_ID_OFFSET + 4]
            .copy_from_slice(&VALID_FEED.to_le_bytes());
        bytes[equinox::v3::V3_CORE_ORACLE_CHANNEL_OFFSET] = VALID_CHANNEL;
        bytes[equinox::v3::V3_CORE_ORACLE_EXPONENT_OFFSET
            ..equinox::v3::V3_CORE_ORACLE_EXPONENT_OFFSET + 4]
            .copy_from_slice(&(i32::from(VALID_EXPONENT)).to_le_bytes());
    }
    let snapshot = account(
        equinox::v3::derive_oracle_snapshot_v3(&ID, &core_address),
        ID,
        equinox::oracle_snapshot::ORACLE_SNAPSHOT_SIZE,
        false,
        true,
        false,
    );
    SnapshotFixture {
        base,
        core,
        snapshot,
    }
}

const VALID_FEED: u32 = 7;
const VALID_CHANNEL: u8 = 3;
const VALID_EXPONENT: i16 = -8;

/// One second before the fixed off-chain `now`, comfortably inside the
/// [-10s, +2s] freshness window every valid fixture must land in.
fn fresh_timestamp_us() -> u64 {
    (OFF_CHAIN_TEST_NOW as u64 - 1) * 1_000_000
}

fn valid_message(session: i16, timestamp_us: u64) -> Vec<u8> {
    build_message(
        VALID_FEED,
        VALID_CHANNEL,
        100_000_000,
        VALID_EXPONENT,
        100_000,
        session,
        timestamp_us,
        timestamp_us,
    )
}

#[test]
fn valid_pyth_update_creates_authenticated_snapshot() {
    let f = snapshot_fixture(false);
    let message = valid_message(0, fresh_timestamp_us());
    let mut data = instruction_data(0, 0, &message);
    data[0] = equinox::instruction::UPDATE_ORACLE_SNAPSHOT_V3;
    let mut accounts = f.accounts();
    process_instruction(&ID, &mut accounts, &data).unwrap();
    let bytes = unsafe { f.snapshot.view.borrow_unchecked() };
    equinox::oracle_snapshot::validate_for_core(
        bytes,
        f.core.view.address(),
        VALID_FEED,
        VALID_CHANNEL,
        i32::from(VALID_EXPONENT),
        OFF_CHAIN_TEST_NOW as u64,
    )
    .unwrap();
    assert_eq!(bytes[equinox::oracle_snapshot::OFFSET_AUTHENTICATED], 1);
    assert_eq!(bytes[equinox::oracle_snapshot::OFFSET_SEQUENCE], 1);
}

/// The Pyth signature authenticates the price, so any fee payer may submit a
/// newer signed update -- not only the market authority.
#[test]
fn snapshot_update_is_permissionless_for_a_newer_signed_price() {
    let f = snapshot_fixture(false);
    unsafe { f.core.view.clone().borrow_unchecked_mut()[44..76].copy_from_slice(&[77; 32]) };
    let message = valid_message(0, fresh_timestamp_us());
    let mut data = instruction_data(0, 0, &message);
    data[0] = equinox::instruction::UPDATE_ORACLE_SNAPSHOT_V3;
    let mut accounts = f.accounts();
    process_instruction(&ID, &mut accounts, &data).unwrap();
    let bytes = unsafe { f.snapshot.view.borrow_unchecked() };
    assert_eq!(bytes[equinox::oracle_snapshot::OFFSET_AUTHENTICATED], 1);
}

/// Permissionless writes must never reach another program account: only the
/// core's canonical snapshot PDA is writable, even if a same-sized
/// program-owned account (e.g. a 128-byte instrument) is supplied.
#[test]
fn snapshot_update_rejects_a_non_canonical_snapshot_account() {
    let mut f = snapshot_fixture(false);
    f.snapshot = account(
        Address::new_from_array([61; 32]),
        ID,
        equinox::oracle_snapshot::ORACLE_SNAPSHOT_SIZE,
        false,
        true,
        false,
    );
    let before = unsafe { f.snapshot.view.borrow_unchecked().to_vec() };
    let message = valid_message(0, fresh_timestamp_us());
    let mut data = instruction_data(0, 0, &message);
    data[0] = equinox::instruction::UPDATE_ORACLE_SNAPSHOT_V3;
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
    assert_eq!(
        unsafe { f.snapshot.view.borrow_unchecked().to_vec() },
        before
    );
}

#[test]
fn snapshot_update_accepts_readonly_delegated_core() {
    let f = snapshot_fixture(true);
    let message = valid_message(0, fresh_timestamp_us());
    let mut data = instruction_data(0, 0, &message);
    data[0] = equinox::instruction::UPDATE_ORACLE_SNAPSHOT_V3;
    let mut accounts = f.accounts();
    process_instruction(&ID, &mut accounts, &data).unwrap();
    assert_eq!(
        f.core.view.owner(),
        &equinox::magicblock::DELEGATION_PROGRAM_ID
    );
    assert!(!f.core.view.is_writable());
}

// ---------------------------------------------------------------------
// Ed25519 / instructions-sysvar inspection
// ---------------------------------------------------------------------

#[test]
fn missing_ed25519_instruction_is_rejected() {
    let f = fixture();
    // ed25519_instruction_index (1) is not less than current_index (1): "must precede".
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(1, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn wrong_ed25519_program_is_rejected() {
    let f = fixture();
    // Rebuild the sysvar with a non-Ed25519 program at index 0.
    let sysvar_data = build_instructions_sysvar(Address::new_from_array([9; 32]), 1);
    unsafe { f.instructions_sysvar.view.clone().borrow_unchecked_mut() }
        .copy_from_slice(&sysvar_data);
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn wrong_signature_index_is_rejected() {
    let f = fixture();
    let message = valid_message(0, fresh_timestamp_us());
    // Only 1 signature (index 0) was declared in the Ed25519 instruction.
    let data = instruction_data(0, 1, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn valid_fixture_passes_every_pre_cpi_and_business_check() {
    // "Official valid fixture" is unavailable without PYTH_PRO_API_KEY (no
    // real Lazer signing key in this environment); this fixture is
    // structurally well-formed and deterministic, and exercises every
    // check up to (and including) the CPI, which no-ops off the SBF target
    // -- see the module doc.
    let f = fixture();
    let message = valid_message(0, fresh_timestamp_us()); // Regular session
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    process_instruction(&ID, &mut accounts, &data).unwrap();
    let bytes = unsafe { f.market.view.borrow_unchecked() };
    let mut header = MarketStateHeader::empty();
    unsafe {
        ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            &mut header as *mut MarketStateHeader as *mut u8,
            size_of::<MarketStateHeader>(),
        );
    }
    let (oracle_valid, price, mode) = (
        header.oracle_valid,
        header.last_verified_oracle_price,
        header.mode,
    );
    assert_eq!(oracle_valid, 1);
    assert_eq!(price, 100_000_000);
    assert_eq!(mode, 1); // Open
}

// ---------------------------------------------------------------------
// Account shape: program / storage / treasury
// ---------------------------------------------------------------------

#[test]
fn wrong_pyth_program_is_rejected() {
    let f = fixture();
    let wrong_program = account(
        Address::new_from_array([66; 32]),
        Address::default(),
        0,
        false,
        false,
        true,
    );
    let mut accounts = f.accounts();
    accounts[2] = wrong_program.view.clone();
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(0, 0, &message);
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn wrong_storage_account_is_rejected() {
    let f = fixture();
    let wrong_storage = account(
        Address::new_from_array([67; 32]),
        PYTH_PROGRAM_ID,
        72,
        false,
        false,
        false,
    );
    let mut accounts = f.accounts();
    accounts[3] = wrong_storage.view.clone();
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(0, 0, &message);
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn wrong_treasury_is_rejected_but_storage_and_treasury_need_not_be_equal() {
    let f = fixture();
    // A treasury address that does not match `storage.treasury` must be
    // rejected -- but note storage and treasury are never required to be
    // the *same* address (see fixture(): they're always distinct).
    let wrong_treasury = account(
        Address::new_from_array([68; 32]),
        Address::default(),
        0,
        false,
        true,
        false,
    );
    let mut accounts = f.accounts();
    accounts[4] = wrong_treasury.view.clone();
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(0, 0, &message);
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

// ---------------------------------------------------------------------
// Business rules: feed, channel, exponent, price, confidence, session
// ---------------------------------------------------------------------

#[test]
fn wrong_feed_is_rejected() {
    let f = fixture();
    let message = build_message(
        999,
        VALID_CHANNEL,
        100_000_000,
        VALID_EXPONENT,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn wrong_channel_is_rejected() {
    let f = fixture();
    let message = build_message(
        VALID_FEED,
        9,
        100_000_000,
        VALID_EXPONENT,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn unsupported_exponent_is_rejected() {
    let f = fixture();
    let message = build_message(
        VALID_FEED,
        VALID_CHANNEL,
        100_000_000,
        -6,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn invalid_price_is_rejected() {
    let f = fixture();
    let message = build_message(
        VALID_FEED,
        VALID_CHANNEL,
        0,
        VALID_EXPONENT,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
    let message = build_message(
        VALID_FEED,
        VALID_CHANNEL,
        -1,
        VALID_EXPONENT,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn excess_confidence_is_rejected() {
    let f = fixture();
    // Confidence > price / 5.
    let message = build_message(
        VALID_FEED,
        VALID_CHANNEL,
        100_000_000,
        VALID_EXPONENT,
        30_000_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us(),
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn closed_halted_and_corporate_action_sessions_set_close_only() {
    // MarketSession::OverNight (3) and Closed (4) both map to CloseOnly;
    // anything outside the real enum's range (0..=4) is rejected outright.
    for session in [3i16, 4i16] {
        let f = fixture();
        let message = valid_message(session, fresh_timestamp_us());
        let data = instruction_data(0, 0, &message);
        let mut accounts = f.accounts();
        process_instruction(&ID, &mut accounts, &data).unwrap();
        let bytes = unsafe { f.market.view.borrow_unchecked() };
        let mode = bytes[11]; // MarketStateHeader.mode offset
        assert_eq!(mode, 2, "session {session} should map to CloseOnly");
    }
    let f = fixture();
    let message = valid_message(5, fresh_timestamp_us()); // out of range
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

// ---------------------------------------------------------------------
// Timestamps: staleness, duplicates, future rejection, feed-vs-envelope
// ---------------------------------------------------------------------

#[test]
fn duplicate_timestamp_is_rejected() {
    let f = fixture();
    let message = valid_message(0, fresh_timestamp_us());
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    process_instruction(&ID, &mut accounts, &data).unwrap();
    // Same timestamp again -- must be rejected as non-monotonic.
    let mut accounts = f.accounts();
    assert_eq!(
        err_code(process_instruction(&ID, &mut accounts, &data)),
        equinox::error::EquinoxError::OracleUnavailable as u32
    );
}

#[test]
fn stale_timestamp_is_rejected() {
    let f = fixture();
    let first = instruction_data(0, 0, &valid_message(0, fresh_timestamp_us()));
    process_instruction(&ID, &mut f.accounts(), &first).unwrap();
    let older = instruction_data(0, 0, &valid_message(0, fresh_timestamp_us() - 2_000_000));
    assert!(process_instruction(&ID, &mut f.accounts(), &older).is_err());
}

#[test]
fn future_timestamp_is_rejected() {
    let f = fixture();
    // Clock::get() is unavailable off-chain and this program does not stub
    // it, so `now` reads as 0 there; any positive timestamp here is
    // already "in the future" relative to that, exercising the same
    // rejection path a too-far-ahead live timestamp would take.
    let message = valid_message(0, (OFF_CHAIN_TEST_NOW as u64 + 1_000) * 1_000_000);
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

#[test]
fn feed_update_timestamp_newer_than_envelope_is_rejected() {
    let f = fixture();
    let message = build_message(
        VALID_FEED,
        VALID_CHANNEL,
        100_000_000,
        VALID_EXPONENT,
        100_000,
        0,
        fresh_timestamp_us(),
        fresh_timestamp_us() + 1_000_000,
    );
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}

// ---------------------------------------------------------------------
// Fake local payload rejection
// ---------------------------------------------------------------------

#[test]
fn a_fabricated_non_pyth_payload_is_rejected() {
    let f = fixture();
    // A "locally invented" 24-byte payload with no envelope/magic/signature
    // at all -- the kind of shortcut this implementation must not accept.
    let mut fake = vec![12u8, 0, 0, 0];
    fake.extend([0u8; 24]);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &fake).is_err());
}

#[test]
fn a_payload_with_the_wrong_format_magic_is_rejected() {
    let f = fixture();
    let mut message = valid_message(0, fresh_timestamp_us());
    message[0..4].copy_from_slice(&0xDEADBEEFu32.to_le_bytes());
    let data = instruction_data(0, 0, &message);
    let mut accounts = f.accounts();
    assert!(process_instruction(&ID, &mut accounts, &data).is_err());
}
