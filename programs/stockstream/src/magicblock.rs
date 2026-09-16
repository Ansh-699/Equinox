//! Real MagicBlock Ephemeral Rollup lifecycle CPIs.
//!
//! StockStream is a `no_std`, no-heap Pinocchio 0.11.2 program. The official
//! `ephemeral-rollups-sdk` (0.17.0) client helpers are Anchor/`solana_program`
//! `AccountInfo`-shaped, and its own instruction/args encoding pulls in `Vec`
//! and (for `magicblock-magic-program-api`) `std::collections::HashMap`,
//! neither of which this program can link (see the `default_panic_handler!`
//! note in `lib.rs`: even the *dependency graph* pulling in `std` was enough
//! to collide with a `no_std` panic handler). Rather than depend on those
//! code paths on-chain, this module hand-encodes the exact wire bytes the
//! delegation program and Magic program expect, verified byte-for-byte in
//! `tests/magicblock.rs` against the real `magicblock-delegation-program-api`
//! (`dlp_api`, `=3.1.0`) and `magicblock-magic-program-api` (`=0.10.1`)
//! crates' own `borsh`/`bincode` serialization (golden vectors), and against
//! the actual `magicblock-labs/delegation-program` `processor/fast/*.rs`
//! source (account order, signer/writable flags, the external-undelegate
//! callback contract) fetched from GitHub during implementation. Program
//! IDs, PDA seed tags and the external-undelegate discriminator are taken
//! directly from `dlp_api` constants -- nothing here is guessed.
//!
//! Only the market account itself is delegated: StockStream's entire hot
//! state (arenas, seats, funding, fill-event ring) lives in one PDA
//! (`state::MARKET_ACCOUNT_SIZE`), so "the hot cluster" is that single
//! account. Per-seat settlement scratch accounts are validated `Empty` (no
//! in-flight plan may cross a delegation boundary) but are not themselves
//! delegated in this pass.
//! ponytail: single-account delegation; delegating the scratch PDAs too is
//! the same CPI looped over each one -- add it when a real ER integration
//! test needs per-seat ER-side scratch.

use core::mem::{size_of, MaybeUninit};

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::StockStreamError,
    handlers::{custom, event_timestamp, initialized_header, market_data, write_header},
    registry::PERP_MARKET_SEED,
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchHeader, SETTLEMENT_SCRATCH_LEN,
    },
    state::DelegationStatus,
};

// ---------------------------------------------------------------------
// Ground-truth constants (see docs/magicblock.md).
// ---------------------------------------------------------------------

/// `dlp_api::fast::ID` -- the Pinocchio-native alias for
/// `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, the official MagicBlock
/// Delegation Program.
pub const DELEGATION_PROGRAM_ID: Address = dlp_api::fast::ID;

/// `Magic11111111111111111111111111111111111111`, the MagicBlock Magic
/// Program. `magicblock-magic-program-api` only exposes this as its own
/// compat `Pubkey` type; the raw bytes are asserted equal to
/// `magicblock_magic_program_api::id()` in `tests/magicblock.rs`.
pub const MAGIC_PROGRAM_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 176, 218, 112, 149, 236, 185, 214, 222, 195, 119, 215, 40, 145, 182, 231, 142,
    146, 234, 18, 214, 223, 187, 58, 64, 0, 0, 0, 0,
]);

/// `MagicContext1111111111111111111111111111111`, asserted against
/// `magicblock_magic_program_api::MAGIC_CONTEXT_PUBKEY` in tests.
pub const MAGIC_CONTEXT_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 196, 165, 40, 191, 95, 180, 3, 47, 68, 82, 130, 142, 187, 56, 171, 193, 210,
    220, 151, 247, 63, 139, 148, 84, 128, 0, 0, 0,
]);

/// The delegation program's required external-undelegate callback
/// discriminator (`dlp_api::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`).
pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] =
    dlp_api::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR;

pub const DELEGATION_RECORD_TAG: &[u8] = dlp_api::pda::DELEGATION_RECORD_TAG;
pub const DELEGATION_METADATA_TAG: &[u8] = dlp_api::pda::DELEGATION_METADATA_TAG;
pub const DELEGATE_BUFFER_TAG: &[u8] = dlp_api::pda::DELEGATE_BUFFER_TAG;
pub const UNDELEGATE_BUFFER_TAG: &[u8] = dlp_api::pda::UNDELEGATE_BUFFER_TAG;

/// Required commit interval: `commit_frequency_ms` must be exactly this.
pub const COMMIT_INTERVAL_MS: u32 = 30_000;

/// `dlp_api::discriminator::DlpDiscriminator::Delegate as u64`.
const DELEGATE_DISCRIMINATOR: u64 = 0;

// ---------------------------------------------------------------------
// Fixed-size wire encoders (no heap allocation). See tests/magicblock.rs for
// the golden-vector cross-check against the real crates' own serializers.
// ---------------------------------------------------------------------

pub const SEEDS_LEN: usize = 4 + (4 + PERP_MARKET_SEED.len()) + (4 + 32);
/// `discriminator(8) + commit_frequency_ms(4) + seeds(SEEDS_LEN) + Some-tag(1) + validator(32)`.
pub const DELEGATE_INSTRUCTION_DATA_LEN: usize = 8 + 4 + SEEDS_LEN + 1 + 32;
/// `EXTERNAL_UNDELEGATE_DISCRIMINATOR(8) || seeds(SEEDS_LEN)`.
pub const EXTERNAL_UNDELEGATE_DATA_LEN: usize = 8 + SEEDS_LEN;

/// Borsh encoding of `vec![b"perp-market".to_vec(), instrument.to_vec()]`,
/// i.e. the `seeds` field of `dlp_api::args::DelegateArgs`. This is also
/// exactly the payload the delegation program replays back in the
/// external-undelegate callback (`DelegationMetadata::seeds`), so the same
/// encoder verifies both directions.
pub fn encode_market_delegate_seeds(instrument: &Address) -> [u8; SEEDS_LEN] {
    let mut out = [0u8; SEEDS_LEN];
    out[0..4].copy_from_slice(&2u32.to_le_bytes());
    let mut offset = 4;
    out[offset..offset + 4].copy_from_slice(&(PERP_MARKET_SEED.len() as u32).to_le_bytes());
    offset += 4;
    out[offset..offset + PERP_MARKET_SEED.len()].copy_from_slice(PERP_MARKET_SEED);
    offset += PERP_MARKET_SEED.len();
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 32].copy_from_slice(instrument.as_ref());
    out
}

/// Full `Delegate` (discriminator 0) instruction data for the delegation
/// program: `u64 discriminator || borsh(DelegateArgs)`.
pub fn encode_delegate_instruction_data(
    instrument: &Address,
    validator: &Address,
) -> [u8; DELEGATE_INSTRUCTION_DATA_LEN] {
    let mut out = [0u8; DELEGATE_INSTRUCTION_DATA_LEN];
    out[0..8].copy_from_slice(&DELEGATE_DISCRIMINATOR.to_le_bytes());
    out[8..12].copy_from_slice(&COMMIT_INTERVAL_MS.to_le_bytes());
    out[12..12 + SEEDS_LEN].copy_from_slice(&encode_market_delegate_seeds(instrument));
    let mut offset = 12 + SEEDS_LEN;
    out[offset] = 1; // Option::Some
    offset += 1;
    out[offset..offset + 32].copy_from_slice(validator.as_ref());
    out
}

/// `bincode::serialize(&MagicBlockInstruction::ScheduleIntentBundle(MagicIntentBundleArgs{
///     commit: Some(CommitTypeArgs::Standalone(vec![2])), ..Default::default()
/// }))`. Account order is fixed as `[payer, magic_context, market]`, so the
/// committed account is always index 2. Golden vector verified in
/// `tests/magicblock.rs`.
pub const SCHEDULE_COMMIT_DATA: [u8; 29] = [
    0x0b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// `bincode::serialize` of `ScheduleIntentBundle` with
/// `commit_and_undelegate: Some(CommitAndUndelegateArgs{ commit_type:
/// Standalone(vec![2]), undelegate_type: Standalone })`, same fixed
/// `[payer, magic_context, market]` account order. Golden vector verified in
/// `tests/magicblock.rs`.
pub const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA: [u8; 33] = [
    0x0b, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
];

fn read_scratch_header(data: &[u8]) -> Result<SettlementScratchHeader, ProgramError> {
    if data.len() != SETTLEMENT_SCRATCH_LEN {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let mut value = MaybeUninit::<SettlementScratchHeader>::uninit();
    // SAFETY: length checked above; `SettlementScratchHeader` is `Copy` and
    // laid out as `repr(C, packed(1))`, so any byte pattern is valid.
    unsafe {
        core::ptr::copy_nonoverlapping(
            data.as_ptr(),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<SettlementScratchHeader>(),
        );
        Ok(value.assume_init())
    }
}

/// Validates that every trailing account is a settlement-scratch PDA for
/// `market` and currently `Empty`. Used by `delegate_market`,
/// `commit_market` and `commit_and_undelegate_market`: no in-flight
/// settlement plan may cross a delegation boundary.
fn require_scratch_accounts_empty(
    program_id: &Address,
    market: &Address,
    scratch_accounts: &[AccountView],
) -> ProgramResult {
    for scratch in scratch_accounts {
        if !scratch.owned_by(program_id) || scratch.data_len() != SETTLEMENT_SCRATCH_LEN {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
        // SAFETY: read-only snapshot; length checked by `read_scratch_header`.
        let header = read_scratch_header(unsafe { scratch.borrow_unchecked() })?;
        if header.market != market.to_bytes()
            || *scratch.address()
                != derive_settlement_scratch(market, header.trader_seat_index, program_id)
        {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
        if header.status != ScratchStatus::Empty as u8 {
            return Err(custom(StockStreamError::MagicBlockScratchNotEmpty));
        }
    }
    Ok(())
}

fn no_duplicate_addresses(addresses: &[&Address]) -> bool {
    for i in 0..addresses.len() {
        for j in (i + 1)..addresses.len() {
            if addresses[i] == addresses[j] {
                return false;
            }
        }
    }
    true
}

// ---------------------------------------------------------------------
// DelegateMarket
// ---------------------------------------------------------------------

/// Accounts:
/// 0. `[WRITE]`          the market PDA being delegated
/// 1. `[SIGNER]`         market authority (must match `header.market_authority`)
/// 2. `[]`               the instrument PDA the market's seeds are derived from
/// 3. `[WRITE, SIGNER]`  fee payer (funds the buffer/record/metadata rent)
/// 4. `[WRITE]`          delegate buffer PDA (`["buffer", market]`, owned by StockStream)
/// 5. `[WRITE]`          delegation record PDA (`["delegation", market]`, delegation program)
/// 6. `[WRITE]`          delegation metadata PDA (`["delegation-metadata", market]`, delegation program)
/// 7. `[]`               the delegation program (must equal `DELEGATION_PROGRAM_ID`)
/// 8. `[]`               the system program
/// 9. `[]`               StockStream's own executable program account (the CPI's `owner_program`)
/// 10.. settlement scratch PDAs for this market, which must be `Empty`
///
/// Local delegation state is only updated after the CPI to the delegation
/// program succeeds.
pub fn delegate_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    validator: Address,
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if validator == Address::default() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !no_duplicate_addresses(&[
        accounts[0].address(),
        accounts[3].address(),
        accounts[4].address(),
        accounts[5].address(),
        accounts[6].address(),
    ]) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[3].is_signer() || !accounts[3].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[7].address() != DELEGATION_PROGRAM_ID
        || *accounts[8].address() != pinocchio_system::ID
        || *accounts[9].address() != *program_id
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    for account in [&accounts[0], &accounts[4], &accounts[5], &accounts[6]] {
        if !account.is_writable() {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
    }

    let authority = accounts[1].address().to_bytes();
    let instrument = *accounts[2].address();
    let market_key = *accounts[0].address();

    let (expected_market, market_bump) =
        Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id);
    if expected_market != market_key {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_buffer, buffer_bump) =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market_key.as_ref()], program_id);
    if expected_buffer != *accounts[4].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_record, _) = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_record != *accounts[5].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_metadata, _) = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_metadata != *accounts[6].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    require_scratch_accounts_empty(program_id, &market_key, &accounts[10..])?;

    let market_data_len = accounts[0].data_len();

    // `AccountView` is a thin `Clone`-able handle onto the runtime's account
    // memory (see `solana-account-view`): cloning it does not copy account
    // data, it makes another handle to the same underlying account, so
    // mutating through any clone is visible through all of them. Using
    // independent clones here (instead of `split_at_mut` on `accounts`)
    // sidesteps a false aliasing conflict from the borrow checker, since the
    // account list mixes accounts this function must mutate (market, buffer)
    // with ones it only reads (payer, delegation record/metadata, ...).
    let mut market_view = accounts[0].clone();
    let mut buffer_view = accounts[4].clone();
    let mut payer_view = accounts[3].clone();
    let delegation_record_view = accounts[5].clone();
    let delegation_metadata_view = accounts[6].clone();
    let system_program_view = accounts[8].clone();
    let owner_program_view = accounts[9].clone();

    // Validate lifecycle state and stamp the new delegation state into the
    // market's own bytes *before* it is mirrored into the buffer: the
    // delegation program's `Delegate` instruction copies the buffer back
    // into this account verbatim as its last step, so this is how the
    // updated state survives the CPI. If any later step in this instruction
    // fails, the whole instruction (and every account write in it,
    // including this one) is rolled back by the runtime, so this still
    // satisfies "only update local state after the CPI succeeds".
    {
        let data = market_data(&mut market_view, program_id)?;
        let mut header = initialized_header(data)?;
        if header.market_authority != authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let status = header.delegation_status();
        if status != DelegationStatus::NotDelegated as u8
            && status != DelegationStatus::Restored as u8
        {
            return Err(custom(StockStreamError::MagicBlockAlreadyDelegated));
        }
        header.set_delegation_status(DelegationStatus::Delegated);
        header.set_validator(validator.to_bytes());
        header.set_delegation_sequence(header.delegation_sequence().saturating_add(1));
        header.set_commit_interval_ms(COMMIT_INTERVAL_MS);
        header.set_expected_commit_sequence(1);
        header.set_pending_undelegation(false);
        let sequence = header
            .global_event_sequence
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        header.global_event_sequence = sequence;
        let delegation_sequence = header.delegation_sequence();
        write_header(data, &header)?;
        // The Delegation Program CPI below either succeeds (this whole
        // instruction, this write included, commits) or fails (the runtime
        // reverts every write in this instruction atomically) -- a failed
        // transaction's logs are still visible over RPC, which is exactly
        // why every indexer-side decoder in this program checks
        // `meta.err` and discards all events from a failed transaction
        // wholesale, rather than relying on emission order relative to
        // the CPI.
        crate::events::emit_event(
            crate::events::EventKind::MarketDelegated,
            &market_key.to_bytes(),
            sequence,
            event_timestamp(),
            &crate::events::payload_delegation(&validator.to_bytes(), delegation_sequence),
        );
    }

    // 1. Create the buffer PDA (owned by StockStream) sized to hold a full
    //    copy of the market account while ownership is in flight.
    let rent = Rent::get()?;
    let buffer_bump_slice = [buffer_bump];
    let buffer_seeds = [
        Seed::from(DELEGATE_BUFFER_TAG),
        Seed::from(market_key.as_ref()),
        Seed::from(&buffer_bump_slice),
    ];
    let buffer_signer = Signer::from(&buffer_seeds);
    CreateAccount {
        from: &payer_view,
        to: &buffer_view,
        lamports: rent.try_minimum_balance(market_data_len)?,
        space: market_data_len as u64,
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(&buffer_signer))?;

    // 2. Copy the market's (now updated) data into the buffer, then zero the
    //    market's data -- the runtime only allows a direct owner change on
    //    zeroed data.
    {
        let market_bytes = unsafe { market_view.borrow_unchecked() };
        let mut buffer_bytes = buffer_view.try_borrow_mut()?;
        buffer_bytes.copy_from_slice(market_bytes);
    }
    unsafe { market_view.borrow_unchecked_mut() }.fill(0);

    // 3. Reassign the market PDA: StockStream -> System Program (direct,
    //    allowed because the data is now zeroed) -> Delegation Program (real
    //    CPI, signed by the market PDA's own seeds).
    let market_bump_slice = [market_bump];
    let market_seeds = [
        Seed::from(PERP_MARKET_SEED),
        Seed::from(instrument.as_ref()),
        Seed::from(&market_bump_slice),
    ];
    let market_signer = Signer::from(&market_seeds);
    unsafe { market_view.assign(&pinocchio_system::ID) };
    {
        let assign_accounts = [InstructionAccount::writable_signer(market_view.address())];
        let mut assign_data = [0u8; 36];
        assign_data[0] = 1;
        assign_data[4..36].copy_from_slice(DELEGATION_PROGRAM_ID.as_ref());
        let assign_ix = InstructionView {
            program_id: &pinocchio_system::ID,
            accounts: &assign_accounts,
            data: &assign_data,
        };
        invoke_signed(
            &assign_ix,
            &[&market_view],
            core::slice::from_ref(&market_signer),
        )?;
    }

    // 4. The real CPI: invoke the Delegation Program's `Delegate`
    //    instruction. Only after this returns `Ok` is the market
    //    considered delegated.
    let delegate_data = encode_delegate_instruction_data(&instrument, &validator);
    let delegate_accounts = [
        InstructionAccount::writable_signer(payer_view.address()),
        InstructionAccount::writable_signer(market_view.address()),
        InstructionAccount::readonly(owner_program_view.address()),
        InstructionAccount::writable(buffer_view.address()),
        InstructionAccount::writable(delegation_record_view.address()),
        InstructionAccount::writable(delegation_metadata_view.address()),
        InstructionAccount::readonly(system_program_view.address()),
    ];
    let delegate_ix = InstructionView {
        program_id: &DELEGATION_PROGRAM_ID,
        accounts: &delegate_accounts,
        data: &delegate_data,
    };
    invoke_signed(
        &delegate_ix,
        &[
            &payer_view,
            &market_view,
            &owner_program_view,
            &buffer_view,
            &delegation_record_view,
            &delegation_metadata_view,
            &system_program_view,
        ],
        core::slice::from_ref(&market_signer),
    )?;

    // 5. The buffer is still owned by StockStream (the delegation program
    //    never reassigns it); drain its lamports back to the payer directly,
    //    no CPI required for an account this program already owns.
    let refund = buffer_view.lamports();
    if refund > 0 {
        buffer_view.set_lamports(0);
        let payer_lamports = payer_view.lamports();
        payer_view.set_lamports(payer_lamports.saturating_add(refund));
    }

    Ok(())
}

// ---------------------------------------------------------------------
// CommitMarket / CommitAndUndelegate
// ---------------------------------------------------------------------

enum CommitKind {
    CommitOnly,
    CommitAndUndelegate,
}

/// Accounts (both `CommitMarket` and `CommitAndUndelegate`):
/// 0. `[WRITE]`         the delegated market PDA
/// 1. `[SIGNER]`        authorized keeper/authority (must match `header.market_authority`)
/// 2. `[WRITE, SIGNER]` fee payer for the Magic Program CPI
/// 3. `[WRITE]`         Magic Context account (must equal `MAGIC_CONTEXT_ID`)
/// 4. `[]`              the Magic Program (must equal `MAGIC_PROGRAM_ID`)
/// 5.. settlement scratch PDAs for this market, which must be `Empty`
fn commit_market_inner(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
    kind: CommitKind,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[2].is_signer() || !accounts[2].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != MAGIC_CONTEXT_ID || !accounts[3].is_writable() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if *accounts[4].address() != MAGIC_PROGRAM_ID {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if sequence == 0 {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }
    if !no_duplicate_addresses(&[
        accounts[0].address(),
        accounts[2].address(),
        accounts[3].address(),
    ]) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let authority = accounts[1].address().to_bytes();
    let market_key = *accounts[0].address();
    require_scratch_accounts_empty(program_id, &market_key, &accounts[5..])?;

    {
        let data = market_data(&mut accounts[0], program_id)?;
        let header = initialized_header(data)?;
        if header.market_authority != authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if header.delegation_status() != DelegationStatus::Delegated as u8 {
            return Err(custom(StockStreamError::MagicBlockNotDelegated));
        }
        if matches!(kind, CommitKind::CommitAndUndelegate) && header.pending_undelegation() {
            return Err(custom(StockStreamError::MagicBlockUndelegationInProgress));
        }
        if sequence != header.expected_commit_sequence() {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
    }

    let commit_data: &[u8] = match kind {
        CommitKind::CommitOnly => &SCHEDULE_COMMIT_DATA,
        CommitKind::CommitAndUndelegate => &SCHEDULE_COMMIT_AND_UNDELEGATE_DATA,
    };
    let commit_accounts = [
        InstructionAccount::writable_signer(accounts[2].address()),
        InstructionAccount::writable(accounts[3].address()),
        InstructionAccount::writable(accounts[0].address()),
    ];
    let commit_ix = InstructionView {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &commit_accounts,
        data: commit_data,
    };
    invoke_signed(&commit_ix, &[&accounts[2], &accounts[3], &accounts[0]], &[])?;

    // Only reachable once the CPI above returned `Ok`.
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    header.set_last_committed_sequence(sequence);
    let event_kind = match kind {
        CommitKind::CommitOnly => {
            header.set_expected_commit_sequence(sequence.saturating_add(1));
            crate::events::EventKind::CommitRequested
        }
        CommitKind::CommitAndUndelegate => {
            header.set_delegation_status(DelegationStatus::Undelegating);
            header.set_pending_undelegation(true);
            header.set_expected_final_commit_sequence(sequence);
            crate::events::EventKind::UndelegationRequested
        }
    };
    let event_sequence = header
        .global_event_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    header.global_event_sequence = event_sequence;
    write_header(data, &header)?;
    crate::events::emit_event(
        event_kind,
        &market_key.to_bytes(),
        event_sequence,
        event_timestamp(),
        &crate::events::payload_delegation(&header.validator(), sequence),
    );
    Ok(())
}

pub fn commit_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    commit_market_inner(program_id, accounts, sequence, CommitKind::CommitOnly)
}

pub fn commit_and_undelegate_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    commit_market_inner(
        program_id,
        accounts,
        sequence,
        CommitKind::CommitAndUndelegate,
    )
}

// ---------------------------------------------------------------------
// External-undelegate callback
// ---------------------------------------------------------------------

/// Accounts, exactly as constructed by the delegation program's
/// `processor/fast/undelegate.rs::cpi_external_undelegate` (fetched from
/// `magicblock-labs/delegation-program` during implementation -- this is not
/// StockStream's choice, it is the delegation program's fixed wire format):
/// 0. `[WRITE]`          the market PDA (closed by the delegation program; this CPI must recreate it)
/// 1. `[WRITE, SIGNER]`  the undelegate-buffer PDA, holding the final committed state
/// 2. `[WRITE, SIGNER]`  the validator identity that is closing out the delegation
/// 3. `[]`               the system program
///
/// The buffer being a *signer* is the actual proof this call came from the
/// delegation program: it is a PDA under `["undelegate-buffer", market]`
/// owned by `DELEGATION_PROGRAM_ID`, so only that program can produce a
/// valid `invoke_signed` for it. Solana does not otherwise expose "which
/// program CPI'd me" to a callee, so this signer check -- not the
/// discriminator alone -- is what rejects a forged callback.
pub fn external_undelegate(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() != EXTERNAL_UNDELEGATE_DATA_LEN || data[0..8] != EXTERNAL_UNDELEGATE_DISCRIMINATOR
    {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let seeds_payload = &data[8..EXTERNAL_UNDELEGATE_DATA_LEN];
    let instrument_bytes: [u8; 32] = seeds_payload[seeds_payload.len() - 32..]
        .try_into()
        .map_err(|_| custom(StockStreamError::MagicBlockInvalidCallback))?;
    let instrument = Address::new_from_array(instrument_bytes);
    if encode_market_delegate_seeds(&instrument) != *seeds_payload {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }

    if !accounts[0].is_writable() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    if !accounts[1].is_signer() || !accounts[1].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[2].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != pinocchio_system::ID {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let (expected_market, market_bump) =
        Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id);
    if expected_market != *accounts[0].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let (expected_buffer, _) = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, accounts[0].address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_buffer != *accounts[1].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    if accounts[0].owned_by(program_id) {
        // A market this program still owns was never actually handed to the
        // delegation program's undelegate flow; recreating it here would
        // silently overwrite live state.
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }

    let buffer_len = accounts[1].data_len();

    // Re-create the market account (the delegation program closed it before
    // this CPI: 0 lamports, 0-length data, owned by the system program) and
    // fund it to exactly the rent-exempt minimum -- the delegation program
    // asserts afterwards that the validator's lamports dropped by exactly
    // that amount, so this must not be more or less.
    let rent = Rent::get()?;
    let market_bump_slice = [market_bump];
    let market_seeds = [
        Seed::from(PERP_MARKET_SEED),
        Seed::from(instrument.as_ref()),
        Seed::from(&market_bump_slice),
    ];
    let market_signer = Signer::from(&market_seeds);
    {
        let (left, right) = accounts.split_at_mut(1);
        CreateAccount {
            from: &right[1], // accounts[2], the validator
            to: &left[0],
            lamports: rent.try_minimum_balance(buffer_len)?,
            space: buffer_len as u64,
            owner: program_id,
        }
        .invoke_signed(core::slice::from_ref(&market_signer))?;
    }

    // Copy the committed state back in, then verify and finalize the
    // lifecycle fields it carries (they were stamped by
    // `commit_and_undelegate_market` before the last commit and survive the
    // round trip through the buffer).
    {
        let (left, right) = accounts.split_at_mut(1);
        let market_bytes = unsafe { left[0].borrow_unchecked_mut() };
        let buffer_bytes = right[0].try_borrow()?;
        market_bytes.copy_from_slice(&buffer_bytes);
    }

    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.delegation_status() != DelegationStatus::Undelegating as u8
        || !header.pending_undelegation()
    {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let final_sequence = header.expected_final_commit_sequence();
    header.set_delegation_status(DelegationStatus::Restored);
    header.set_pending_undelegation(false);
    header.set_last_committed_sequence(final_sequence);
    let event_sequence = header
        .global_event_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    header.global_event_sequence = event_sequence;
    let validator = header.validator();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::MarketRestored,
        &market_key,
        event_sequence,
        event_timestamp(),
        &crate::events::payload_delegation(&validator, final_sequence),
    );
    Ok(())
}
