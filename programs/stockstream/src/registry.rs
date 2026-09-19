use core::mem::size_of;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    error::StockStreamError,
    events::{
        emit_event, payload_empty, payload_registry, payload_seat_amount, EventKind, NO_SEAT,
    },
    handlers,
    instruction::exchange_config_field as field,
};

/// Registry-level events (Exchange/StockInstrument/PerpMarketCreated) have
/// no dedicated monotonic sequence counter of their own -- `ExchangeConfig`
/// and `StockInstrument` predate the market-level `global_event_sequence`
/// convention and are governance-cadence, not high-frequency trading,
/// state. `0` is used for all of them; an indexer distinguishes registry
/// events from each other and from replays by transaction signature and
/// slot, not by a per-event sequence. `EventHeader.market` holds the
/// exchange/instrument/market address most relevant to the event (not
/// always a `PerpMarket` account), documented per call site below.
const REGISTRY_EVENT_SEQUENCE: u64 = 0;

pub const EXCHANGE_DISCRIMINATOR: [u8; 8] = *b"STKEXC01";
pub const INSTRUMENT_DISCRIMINATOR: [u8; 8] = *b"STKINS01";
pub const INSTRUMENT_SIZE: usize = 128;
/// Bumped from 1: `ExchangeConfig` grew from a bare identity record
/// (authority + instrument count) to hold the governance-mutable fields
/// `UpdateExchangeConfig` operates on (authorities, default fee/risk
/// parameters, collateral/oracle policy, insurance target, protocol
/// status, a config sequence). StockStream has never been deployed, so
/// this is a clean layout change, not a migration.
pub const EXCHANGE_CONFIG_VERSION: u16 = 2;
pub const EXCHANGE_SIZE: usize = 256;
pub const INSTRUMENT_SEED: &[u8] = b"instrument";
pub const PERP_MARKET_SEED: &[u8] = b"perp-market";

/// Hard governance safety rails for `UpdateExchangeConfig` -- not
/// business requirements copied from elsewhere (no exchange-level fee/risk
/// bound existed anywhere in this codebase before), but conservative,
/// explicit caps a malicious or fat-fingered exchange authority cannot
/// exceed even with full signing authority. `BPS_DENOMINATOR` (10_000)
/// is the existing basis-point convention this program already uses
/// (`risk.rs`).
pub const MAX_FEE_BPS: u16 = 1_000; // 10%
pub const MAX_MARGIN_BPS: u16 = 10_000; // 100%
pub const MAX_DEFAULT_LEVERAGE: u32 = 125;

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct ExchangeConfig {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    /// Listing/registration authority -- the exchange's immutable
    /// identity. `UpdateExchangeConfig` never changes this; rotating it
    /// would need a distinct, explicitly-named instruction (e.g. a
    /// two-step authority transfer), not a field-mask update, so that a
    /// governance mistake can't silently hand away exchange control.
    pub authority: [u8; 32],
    pub instrument_count: u32,
    pub pause_authority: [u8; 32],
    pub emergency_authority: [u8; 32],
    pub keeper_authority: [u8; 32],
    pub maker_fee_bps: u16,
    pub taker_fee_bps: u16,
    pub liquidation_fee_bps: u16,
    pub default_initial_margin_bps: u16,
    pub default_maintenance_margin_bps: u16,
    pub default_maximum_leverage: u32,
    /// The single collateral mint new markets are expected to use.
    /// Deliberately minimal (one mint, not a whitelist): every other
    /// custody path in this program already assumes one collateral mint
    /// per market (`MarketStateHeader.collateral_mint`); this is that
    /// same policy expressed once at the exchange level as the default/
    /// enforced choice, not a new multi-asset design.
    pub collateral_mint: [u8; 32],
    /// The single oracle program markets are expected to verify updates
    /// against (e.g. the Pyth Lazer Solana contract's program id).
    pub oracle_program: [u8; 32],
    pub insurance_target_balance: u64,
    pub protocol_status: u8,
    /// Increments on every successful `UpdateExchangeConfig`. Lets a
    /// caller submit `expected_config_sequence` to detect and reject a
    /// stale read-modify-write race against a concurrent update, the same
    /// optimistic-concurrency role `session_generation` plays for trading
    /// sessions.
    pub config_sequence: u64,
    pub reserved: [u8; 18],
}
const _: [(); EXCHANGE_SIZE] = [(); size_of::<ExchangeConfig>()];

/// `ProtocolStatus` for `ExchangeConfig.protocol_status`. Exchange-wide,
/// distinct from any single market's own `MarketMode`: `Halted` is a
/// stronger, exchange-level circuit breaker a keeper/UI can check before
/// acting on *any* market, independent of each market's individual mode.
#[repr(u8)]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum ProtocolStatus {
    Active = 0,
    Paused = 1,
    Halted = 2,
}

impl ProtocolStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Active),
            1 => Some(Self::Paused),
            2 => Some(Self::Halted),
            _ => None,
        }
    }
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct StockInstrument {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub instrument_id: [u8; 32],
    pub symbol_hash: [u8; 32],
    pub oracle_feed_hash: [u8; 32],
    pub price_exponent: i32,
    pub reserved: [u8; 17],
}
const _: [(); INSTRUMENT_SIZE] = [(); size_of::<StockInstrument>()];

pub fn derive_instrument(program_id: &Address, _exchange: &Address, id: &[u8; 32]) -> Address {
    Address::find_program_address(&[INSTRUMENT_SEED, id], program_id).0
}

pub fn derive_perp_market(program_id: &Address, instrument: &Address) -> Address {
    Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id).0
}

/// Opcode 43: creates the stock-instrument PDA account itself (128 bytes,
/// within one allocate's 10,240-byte inner-instruction cap, so one CPI does
/// fund + allocate + assign in a single instruction).
///
/// Accounts:
/// 0. `[WRITE]`          the instrument PDA to create (must not exist)
/// 1. `[WRITE, SIGNER]`  payer
/// 2. `[]`               the system program
/// 3. `[]`               the instrument id (32 bytes, via instruction data)
pub fn create_instrument_account(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: &[u8; 32],
) -> ProgramResult {
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[0].is_writable() || !accounts[1].is_signer() || !accounts[1].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[2].address() != pinocchio_system::ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if accounts[0].data_len() != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let (expected, bump) = Address::find_program_address(&[INSTRUMENT_SEED, id], program_id);
    if expected != *accounts[0].address() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let bump_slice = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(INSTRUMENT_SEED),
        pinocchio::cpi::Seed::from(id.as_ref()),
        pinocchio::cpi::Seed::from(&bump_slice),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds);
    pinocchio_system::instructions::Allocate {
        account: &accounts[0],
        space: INSTRUMENT_SIZE as u64,
    }
    .invoke_signed(core::slice::from_ref(&signer))?;
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(INSTRUMENT_SIZE)?;
    let deficit = lamports.saturating_sub(accounts[0].lamports());
    if deficit > 0 {
        pinocchio_system::instructions::Transfer {
            from: &accounts[1],
            to: &accounts[0],
            lamports: deficit,
        }
        .invoke()?;
    }
    pinocchio_system::instructions::Assign {
        account: &accounts[0],
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(&signer))
}

/// Opcode 42: creates (or grows) the perp-market PDA account itself.
///
/// A PDA cannot sign a client transaction, so the client cannot pre-create
/// the market account the way `CreatePerpMarket` expects (`account_data`
/// requires a program-owned, exactly-`MARKET_ACCOUNT_SIZE`-byte account).
///
/// Solana caps every inner-instruction account growth at
/// `MAX_PERMITTED_DATA_INCREASE` (10,240 bytes), so the 222,752-byte market
/// account is built INCREMENTALLY: each call performs exactly one growth
/// step and the client repeats the instruction (typically many of them in
/// one transaction) until the account reaches `MARKET_ACCOUNT_SIZE`. The
/// stages are:
///
/// 1. data_len == 0 (system-owned): fund to the rent-exempt minimum, then
///    `system::allocate(10,240)` + `system::assign(StockStream)` via CPIs
///    signed by the market PDA's own seeds;
/// 2. data_len < MARKET_ACCOUNT_SIZE (program-owned): `AccountView::resize`
///    by up to 10,240 bytes (the runtime's own realloc, owner-only);
/// 3. data_len == MARKET_ACCOUNT_SIZE: no-op success (idempotent, so the
///    client may simply loop until it reaches the full size).
///
/// Accounts:
/// 0. `[]`               the instrument PDA the market's seeds derive from
/// 1. `[WRITE]`          the market PDA being built
/// 2. `[WRITE, SIGNER]`  payer (funds the rent-exempt minimum)
/// 3. `[]`               the system program
/// Opcode 44: creates the vault SPL token account (165 bytes) at the
/// vault PDA address, owned by the vault-authority PDA, then configures the
/// market header. This is the last piece of client-side custody setup that
/// cannot be done without a program-side CPI.
///
/// The System Program's `allocate` requires the target account's signature,
/// which a PDA can only provide via `invoke_signed` — so this instruction
/// performs fund + allocate + SPL initializeAccount3 in one atomic
/// instruction, all CPIs signed by the vault PDA's own seeds.
///
/// Accounts (exactly 6 -- the account-ABI hardening pass removed one
/// genuinely unused slot this handler never read; `token_program` stays and
/// is now validated -- it is still required as a real account even though
/// the CPI's `program_id` is the hardcoded canonical Tokenkeg constant,
/// because a CPI's target program must be present among the *current*
/// instruction's own accounts for the runtime to locate its executable
/// data; leaving it unchecked was the original hardening gap, not the
/// account's presence itself):
/// 0. `[WRITE]`          the market PDA (validated + header configured)
/// 1. `[WRITE]`          the vault PDA to create (must not exist)
/// 2. `[WRITE, SIGNER]`  payer (funds the rent-exempt minimum; must equal
///                        the market's own `market_authority`)
/// 3. `[]`               the mint (SPL Token)
/// 4. `[]`               the SPL Token program (Tokenkeg)
/// 5. `[]`               the system program
///
/// Data: `[tag(1)]` (no arguments beyond the market).
pub fn create_vault_account(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[0].is_writable()
        || !accounts[1].is_writable()
        || !accounts[2].is_signer()
        || !accounts[2].is_writable()
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[4].address() != crate::handlers::TOKEN_PROGRAM_ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if *accounts[5].address() != pinocchio_system::ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if accounts[1].data_len() != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let market_key = *accounts[0].address();
    let vault_key = *accounts[1].address();
    let (expected_vault, vault_bump) =
        Address::find_program_address(&[b"vault", market_key.as_ref()], program_id);
    if expected_vault != vault_key {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    {
        let market_bytes = unsafe { accounts[0].borrow_unchecked() };
        let header = crate::handlers::initialized_header(&market_bytes)?;
        if header.reserved_upgrade[1] != 0 {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        if accounts[2].address().to_bytes() != header.market_authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    let bump_slice = [vault_bump];
    let vault_seeds = [
        pinocchio::cpi::Seed::from(b"vault"),
        pinocchio::cpi::Seed::from(market_key.as_ref()),
        pinocchio::cpi::Seed::from(&bump_slice),
    ];
    let vault_signer = pinocchio::cpi::Signer::from(&vault_seeds);

    // SystemProgram::createAccount sets space, owner, and lamports in one
    // atomic instruction, signed by the vault PDA's own seeds.
    pinocchio_system::instructions::CreateAccount {
        from: &accounts[2],
        to: &accounts[1],
        lamports: Rent::get()?.try_minimum_balance(crate::handlers::TOKEN_ACCOUNT_LEN)?,
        space: crate::handlers::TOKEN_ACCOUNT_LEN as u64,
        owner: &crate::handlers::TOKEN_PROGRAM_ID,
    }
    .invoke_signed(core::slice::from_ref(&vault_signer))?;

    // 4. SPL initializeAccount3 (opcode 18): no vault signature required.
    let vault_authority_address = crate::handlers::derive_vault_authority(&market_key, program_id);
    let mint_address = *accounts[3].address();
    // SPL initializeAccount3: the owner is in the INSTRUCTION DATA (not a
    // separate account). The SPL Token account list is [account(w), mint(ro)]
    // with the owner embedded in the data as 32 bytes after the opcode.
    let mut init_data = [0u8; 33];
    init_data[0] = 18; // InitializeAccount3 opcode
    init_data[1..33].copy_from_slice(vault_authority_address.as_ref());
    let init_accounts = [
        pinocchio::instruction::InstructionAccount::writable(&vault_key),
        pinocchio::instruction::InstructionAccount::readonly(&mint_address),
    ];
    let init_ix = pinocchio::instruction::InstructionView {
        program_id: &crate::handlers::TOKEN_PROGRAM_ID,
        accounts: &init_accounts,
        data: &init_data,
    };
    {
        let mut vault_view = accounts[1].clone();
        let mut mint_view = accounts[3].clone();
        pinocchio::cpi::invoke_signed(
            &init_ix,
            &[&vault_view, &mint_view],
            core::slice::from_ref(&vault_signer),
        )?;
    }

    // 5. Configure the market header.
    {
        let (market_split, rest) = accounts.split_at_mut(1);
        crate::handlers::configure_vault_header(
            program_id,
            &mut market_split[0],
            &rest[2],
            &rest[1].address().to_bytes(),
            &rest[2].address().to_bytes(),
        )
    }
}

pub fn create_market_account(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    use crate::state::MARKET_ACCOUNT_SIZE;
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_writable() || !accounts[2].is_signer() || !accounts[2].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != pinocchio_system::ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let instrument = *accounts[0].address();
    let market_key = *accounts[1].address();
    let (expected_market, market_bump) =
        Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id);
    if expected_market != market_key {
        return Err(custom(StockStreamError::InvalidInstruction));
    }

    let data_len = accounts[1].data_len();
    if data_len == MARKET_ACCOUNT_SIZE && accounts[1].owned_by(program_id) {
        // Already fully created (idempotent).
        return Ok(());
    }

    let market_bump_slice = [market_bump];
    let market_seeds = [
        pinocchio::cpi::Seed::from(PERP_MARKET_SEED),
        pinocchio::cpi::Seed::from(instrument.as_ref()),
        pinocchio::cpi::Seed::from(&market_bump_slice),
    ];
    let market_signer = pinocchio::cpi::Signer::from(&market_seeds);

    if data_len == 0 {
        if accounts[1].owned_by(program_id) || !accounts[1].owned_by(&pinocchio_system::ID) {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        // Order matters: the System Program's `allocate` requires the
        // account to hold ZERO lamports, so allocate FIRST (the rent-exempt
        // check only runs at the END of the whole instruction), then fund to
        // the rent-exempt minimum of the FULL market size, then assign.
        // 1. Allocate the first (10,240-byte) chunk via CPI.
        pinocchio_system::instructions::Allocate {
            account: &accounts[1],
            space: 10_240,
        }
        .invoke_signed(core::slice::from_ref(&market_signer))?;
        // 2. Fund to the rent-exempt minimum for the FULL market size.
        let rent = Rent::get()?;
        let needed = rent.try_minimum_balance(MARKET_ACCOUNT_SIZE)?;
        let deficit = needed.saturating_sub(accounts[1].lamports());
        if deficit > 0 {
            pinocchio_system::instructions::Transfer {
                from: &accounts[2],
                to: &accounts[1],
                lamports: deficit,
            }
            .invoke()?;
        }
        // 3. Assign ownership to this program, so every later growth is a
        //    plain program-side realloc.
        pinocchio_system::instructions::Assign {
            account: &accounts[1],
            owner: program_id,
        }
        .invoke_signed(core::slice::from_ref(&market_signer))?;
        return Ok(());
    }

    // Growth phase: the market PDA must be StockStream-owned now.
    if !accounts[1].owned_by(program_id) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if data_len > MARKET_ACCOUNT_SIZE {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    // The runtime caps every instruction's account-data growth at
    // MAX_PERMITTED_DATA_INCREASE (10,240 bytes) and grows the storage from
    // the account descriptor's own `data_len` field (the field the SVM
    // documents as "Modifiable by programs"). solana-account-view 2.0 has
    // no resize API, so the growth is written through the descriptor
    // directly -- the same write the runtime performs for `close()` and the
    // same mechanism `AccountInfo::realloc` uses on the program side.
    const MAX_PERMITTED_DATA_INCREASE: usize = 10_240;
    let target = (data_len + MAX_PERMITTED_DATA_INCREASE).min(MARKET_ACCOUNT_SIZE);
    unsafe {
        let account = accounts[1].account_mut_ptr();
        core::ptr::write_unaligned(&mut (*account).data_len as *mut u64, target as u64);
    }
    Ok(())
}

fn account_data<'a>(
    account: &'a mut AccountView,
    program_id: &Address,
    len: usize,
) -> Result<&'a mut [u8], ProgramError> {
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !account.owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }
    if account.data_len() != len {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    unsafe { Ok(account.borrow_unchecked_mut()) }
}

fn custom(error: StockStreamError) -> ProgramError {
    error.into()
}

fn validate_registry_accounts(program_id: &Address, accounts: &[AccountView]) -> ProgramResult {
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[0].owned_by(program_id) || !accounts[1].owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }
    if !accounts[2].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if accounts[0].address() == accounts[1].address()
        || accounts[0].address() == accounts[2].address()
        || accounts[1].address() == accounts[2].address()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let exchange = accounts[0].try_borrow()?;
    if exchange.len() != EXCHANGE_SIZE
        || exchange[..8] != EXCHANGE_DISCRIMINATOR
        || exchange[8..10] != EXCHANGE_CONFIG_VERSION.to_le_bytes()
        || exchange[10] != 1
        || exchange[11..43] != accounts[2].address().to_bytes()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn initialize_exchange(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let authority = accounts[1].address().to_bytes();
    let data = account_data(&mut accounts[0], program_id, EXCHANGE_SIZE)?;
    if data[0..8] == EXCHANGE_DISCRIMINATOR && data[10] != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    data.fill(0);
    data[0..8].copy_from_slice(&EXCHANGE_DISCRIMINATOR);
    data[8..10].copy_from_slice(&EXCHANGE_CONFIG_VERSION.to_le_bytes());
    data[10] = 1;
    data[11..43].copy_from_slice(&authority);
    // Every governance-mutable field starts at a safe, explicit default:
    // no pause/emergency/keeper authority (all-zero, so any instruction
    // gated on one of them must be explicitly configured via
    // `UpdateExchangeConfig` before it can be used), zero fees, and
    // `ProtocolStatus::Active`. `data.fill(0)` above already zeroed
    // authorities/fees/mints/insurance target; only `protocol_status`
    // needs an explicit non-zero-coincidence value, and `Active == 0`
    // already matches that zeroed state.
    emit_event(
        EventKind::ExchangeInitialized,
        &accounts[0].address().to_bytes(),
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_empty(),
    );
    Ok(())
}

pub fn register_instrument(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
) -> ProgramResult {
    validate_registry_accounts(program_id, accounts)?;
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[2].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[1].address() != derive_instrument(program_id, accounts[0].address(), &id) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let exchange = unsafe { accounts[0].borrow_unchecked() };
    if exchange.len() != EXCHANGE_SIZE
        || exchange[0..8] != EXCHANGE_DISCRIMINATOR
        || exchange[10] == 0
        || exchange[11..43] != accounts[2].address().to_bytes()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = account_data(&mut accounts[1], program_id, INSTRUMENT_SIZE)?;
    if data[0..8] == INSTRUMENT_DISCRIMINATOR && data[10] != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    data.fill(0);
    data[0..8].copy_from_slice(&INSTRUMENT_DISCRIMINATOR);
    data[8..10].copy_from_slice(&1u16.to_le_bytes());
    data[10] = 1;
    data[11..43].copy_from_slice(&id);
    emit_event(
        EventKind::StockInstrumentRegistered,
        &accounts[1].address().to_bytes(),
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_registry(&id),
    );
    Ok(())
}

pub fn update_instrument(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
    pyth_feed_id: u32,
    oracle_channel: u8,
    exponent: i32,
) -> ProgramResult {
    validate_registry_accounts(program_id, accounts)?;
    if pyth_feed_id == 0 || !(1..=4).contains(&oracle_channel) || !(-12..=0).contains(&exponent) {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3
        || !accounts[2].is_signer()
        || *accounts[1].address() != derive_instrument(program_id, accounts[0].address(), &id)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let exchange = unsafe { accounts[0].borrow_unchecked() };
    if exchange.len() != EXCHANGE_SIZE
        || exchange[0..8] != EXCHANGE_DISCRIMINATOR
        || exchange[11..43] != accounts[2].address().to_bytes()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = account_data(&mut accounts[1], program_id, INSTRUMENT_SIZE)?;
    if data[0..8] != INSTRUMENT_DISCRIMINATOR || data[10] == 0 || data[11..43] != id {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    data[75..79].copy_from_slice(&pyth_feed_id.to_le_bytes());
    data[79] = oracle_channel;
    data[107..111].copy_from_slice(&exponent.to_le_bytes());
    emit_event(
        EventKind::StockInstrumentUpdated,
        &accounts[1].address().to_bytes(),
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_registry(&id),
    );
    Ok(())
}

pub fn suspend_instrument(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
) -> ProgramResult {
    validate_registry_accounts(program_id, accounts)?;
    if accounts.len() < 3
        || !accounts[2].is_signer()
        || *accounts[1].address() != derive_instrument(program_id, accounts[0].address(), &id)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let exchange = unsafe { accounts[0].borrow_unchecked() };
    if exchange.len() != EXCHANGE_SIZE || exchange[11..43] != accounts[2].address().to_bytes() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = account_data(&mut accounts[1], program_id, INSTRUMENT_SIZE)?;
    if data[0..8] != INSTRUMENT_DISCRIMINATOR || data[11..43] != id {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    data[111] = 1;
    emit_event(
        EventKind::StockInstrumentSuspended,
        &accounts[1].address().to_bytes(),
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_registry(&id),
    );
    Ok(())
}

pub fn create_perp_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[2].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[0].owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }
    if *accounts[1].address() != derive_perp_market(program_id, accounts[0].address()) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let instrument = unsafe { accounts[0].borrow_unchecked() };
    if instrument.len() != INSTRUMENT_SIZE
        || instrument[0..8] != INSTRUMENT_DISCRIMINATOR
        || instrument[10] == 0
        || instrument[111] != 0
        || instrument[11..43] != id
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let pyth_feed_id = u32::from_le_bytes(instrument[75..79].try_into().unwrap());
    let oracle_channel = instrument[79];
    let price_exponent = i32::from_le_bytes(instrument[107..111].try_into().unwrap());
    if pyth_feed_id == 0
        || !(1..=4).contains(&oracle_channel)
        || !(-12..=0).contains(&price_exponent)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let authority = accounts[2].address().clone();
    let market_key = accounts[1].address().to_bytes();
    handlers::initialize_market_account(program_id, &mut accounts[1], &authority, &id)?;
    handlers::configure_market_oracle(
        program_id,
        &mut accounts[1],
        pyth_feed_id,
        oracle_channel,
        price_exponent,
    )?;
    emit_event(
        EventKind::PerpMarketCreated,
        &market_key,
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_registry(&id),
    );
    Ok(())
}

/// Byte offsets within `ExchangeConfig`'s raw account data (packed(1), so
/// tightly packed with no alignment gaps -- matches the struct's own field
/// order exactly). Kept as named offsets rather than pointer-casting to
/// the struct, consistent with every other function in this file.
mod exchange_offset {
    pub const PAUSE_AUTHORITY: usize = 47;
    pub const EMERGENCY_AUTHORITY: usize = 79;
    pub const KEEPER_AUTHORITY: usize = 111;
    pub const MAKER_FEE_BPS: usize = 143;
    pub const TAKER_FEE_BPS: usize = 145;
    pub const LIQUIDATION_FEE_BPS: usize = 147;
    pub const DEFAULT_INITIAL_MARGIN_BPS: usize = 149;
    pub const DEFAULT_MAINTENANCE_MARGIN_BPS: usize = 151;
    pub const DEFAULT_MAXIMUM_LEVERAGE: usize = 153;
    pub const COLLATERAL_MINT: usize = 157;
    pub const ORACLE_PROGRAM: usize = 189;
    pub const INSURANCE_TARGET_BALANCE: usize = 221;
    pub const PROTOCOL_STATUS: usize = 229;
    pub const CONFIG_SEQUENCE: usize = 230;
}

pub struct UpdateExchangeConfigInput {
    pub field_mask: u32,
    pub pause_authority: [u8; 32],
    pub emergency_authority: [u8; 32],
    pub keeper_authority: [u8; 32],
    pub maker_fee_bps: u16,
    pub taker_fee_bps: u16,
    pub liquidation_fee_bps: u16,
    pub default_initial_margin_bps: u16,
    pub default_maintenance_margin_bps: u16,
    pub default_maximum_leverage: u32,
    pub collateral_mint: [u8; 32],
    pub oracle_program: [u8; 32],
    pub insurance_target_balance: u64,
    pub protocol_status: u8,
    pub expected_config_sequence: u64,
}

/// Accounts: `[exchange (writable), authority (signer)]`. Applies only
/// the fields named in `input.field_mask`; every other field in `input`
/// is present on the wire (fixed-length, unambiguous decode) but ignored.
/// Never touches `authority` (the exchange's listing identity) or
/// `instrument_count` (derived) -- there is no field-mask bit for either.
pub fn update_exchange_config(
    program_id: &Address,
    accounts: &mut [AccountView],
    input: UpdateExchangeConfigInput,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if input.field_mask & !crate::instruction::exchange_config_field::ALL_KNOWN != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let authority = accounts[1].address().to_bytes();
    let exchange_key = accounts[0].address().to_bytes();
    let data = account_data(&mut accounts[0], program_id, EXCHANGE_SIZE)?;
    if data[0..8] != EXCHANGE_DISCRIMINATOR
        || data[8..10] != EXCHANGE_CONFIG_VERSION.to_le_bytes()
        || data[10] == 0
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    // Require the current exchange authority: the same immutable listing
    // authority `initialize_exchange` set, never a pause/emergency/keeper
    // authority (those are themselves only settable *by* this check).
    if data[11..43] != authority {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let current_sequence = u64::from_le_bytes(
        data[exchange_offset::CONFIG_SEQUENCE..exchange_offset::CONFIG_SEQUENCE + 8]
            .try_into()
            .unwrap(),
    );
    if input.expected_config_sequence != current_sequence {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    // Reject a no-op update outright: a field mask of zero changes
    // nothing and would otherwise silently succeed while only bumping
    // the sequence, which is not useful and likely a caller bug.
    if input.field_mask == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if input.field_mask & field::MAKER_FEE_BPS != 0 && input.maker_fee_bps > MAX_FEE_BPS
        || input.field_mask & field::TAKER_FEE_BPS != 0 && input.taker_fee_bps > MAX_FEE_BPS
        || input.field_mask & field::LIQUIDATION_FEE_BPS != 0
            && input.liquidation_fee_bps > MAX_FEE_BPS
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let initial_margin = if input.field_mask & field::DEFAULT_INITIAL_MARGIN_BPS != 0 {
        input.default_initial_margin_bps
    } else {
        u16::from_le_bytes(
            data[exchange_offset::DEFAULT_INITIAL_MARGIN_BPS
                ..exchange_offset::DEFAULT_INITIAL_MARGIN_BPS + 2]
                .try_into()
                .unwrap(),
        )
    };
    let maintenance_margin = if input.field_mask & field::DEFAULT_MAINTENANCE_MARGIN_BPS != 0 {
        input.default_maintenance_margin_bps
    } else {
        u16::from_le_bytes(
            data[exchange_offset::DEFAULT_MAINTENANCE_MARGIN_BPS
                ..exchange_offset::DEFAULT_MAINTENANCE_MARGIN_BPS + 2]
                .try_into()
                .unwrap(),
        )
    };
    if input.field_mask
        & (field::DEFAULT_INITIAL_MARGIN_BPS | field::DEFAULT_MAINTENANCE_MARGIN_BPS)
        != 0
        && (initial_margin == 0
            || maintenance_margin == 0
            || initial_margin > MAX_MARGIN_BPS
            || maintenance_margin > initial_margin)
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    if input.field_mask & field::DEFAULT_MAXIMUM_LEVERAGE != 0
        && (input.default_maximum_leverage == 0
            || input.default_maximum_leverage > MAX_DEFAULT_LEVERAGE)
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    if input.field_mask & field::PAUSE_AUTHORITY != 0 && input.pause_authority == [0u8; 32]
        || input.field_mask & field::EMERGENCY_AUTHORITY != 0
            && input.emergency_authority == [0u8; 32]
        || input.field_mask & field::KEEPER_AUTHORITY != 0 && input.keeper_authority == [0u8; 32]
        || input.field_mask & field::COLLATERAL_MINT != 0 && input.collateral_mint == [0u8; 32]
        || input.field_mask & field::ORACLE_PROGRAM != 0 && input.oracle_program == [0u8; 32]
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if input.field_mask & field::PROTOCOL_STATUS != 0
        && ProtocolStatus::from_u8(input.protocol_status).is_none()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if input.field_mask & field::PAUSE_AUTHORITY != 0 {
        data[exchange_offset::PAUSE_AUTHORITY..exchange_offset::PAUSE_AUTHORITY + 32]
            .copy_from_slice(&input.pause_authority);
    }
    if input.field_mask & field::EMERGENCY_AUTHORITY != 0 {
        data[exchange_offset::EMERGENCY_AUTHORITY..exchange_offset::EMERGENCY_AUTHORITY + 32]
            .copy_from_slice(&input.emergency_authority);
    }
    if input.field_mask & field::KEEPER_AUTHORITY != 0 {
        data[exchange_offset::KEEPER_AUTHORITY..exchange_offset::KEEPER_AUTHORITY + 32]
            .copy_from_slice(&input.keeper_authority);
    }
    if input.field_mask & field::MAKER_FEE_BPS != 0 {
        data[exchange_offset::MAKER_FEE_BPS..exchange_offset::MAKER_FEE_BPS + 2]
            .copy_from_slice(&input.maker_fee_bps.to_le_bytes());
    }
    if input.field_mask & field::TAKER_FEE_BPS != 0 {
        data[exchange_offset::TAKER_FEE_BPS..exchange_offset::TAKER_FEE_BPS + 2]
            .copy_from_slice(&input.taker_fee_bps.to_le_bytes());
    }
    if input.field_mask & field::LIQUIDATION_FEE_BPS != 0 {
        data[exchange_offset::LIQUIDATION_FEE_BPS..exchange_offset::LIQUIDATION_FEE_BPS + 2]
            .copy_from_slice(&input.liquidation_fee_bps.to_le_bytes());
    }
    if input.field_mask & field::DEFAULT_INITIAL_MARGIN_BPS != 0 {
        data[exchange_offset::DEFAULT_INITIAL_MARGIN_BPS
            ..exchange_offset::DEFAULT_INITIAL_MARGIN_BPS + 2]
            .copy_from_slice(&input.default_initial_margin_bps.to_le_bytes());
    }
    if input.field_mask & field::DEFAULT_MAINTENANCE_MARGIN_BPS != 0 {
        data[exchange_offset::DEFAULT_MAINTENANCE_MARGIN_BPS
            ..exchange_offset::DEFAULT_MAINTENANCE_MARGIN_BPS + 2]
            .copy_from_slice(&input.default_maintenance_margin_bps.to_le_bytes());
    }
    if input.field_mask & field::DEFAULT_MAXIMUM_LEVERAGE != 0 {
        data[exchange_offset::DEFAULT_MAXIMUM_LEVERAGE
            ..exchange_offset::DEFAULT_MAXIMUM_LEVERAGE + 4]
            .copy_from_slice(&input.default_maximum_leverage.to_le_bytes());
    }
    if input.field_mask & field::COLLATERAL_MINT != 0 {
        data[exchange_offset::COLLATERAL_MINT..exchange_offset::COLLATERAL_MINT + 32]
            .copy_from_slice(&input.collateral_mint);
    }
    if input.field_mask & field::ORACLE_PROGRAM != 0 {
        data[exchange_offset::ORACLE_PROGRAM..exchange_offset::ORACLE_PROGRAM + 32]
            .copy_from_slice(&input.oracle_program);
    }
    if input.field_mask & field::INSURANCE_TARGET_BALANCE != 0 {
        data[exchange_offset::INSURANCE_TARGET_BALANCE
            ..exchange_offset::INSURANCE_TARGET_BALANCE + 8]
            .copy_from_slice(&input.insurance_target_balance.to_le_bytes());
    }
    if input.field_mask & field::PROTOCOL_STATUS != 0 {
        data[exchange_offset::PROTOCOL_STATUS] = input.protocol_status;
    }
    let new_sequence = current_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    data[exchange_offset::CONFIG_SEQUENCE..exchange_offset::CONFIG_SEQUENCE + 8]
        .copy_from_slice(&new_sequence.to_le_bytes());
    emit_event(
        EventKind::ExchangeConfigUpdated,
        &exchange_key,
        REGISTRY_EVENT_SEQUENCE,
        handlers::event_timestamp(),
        &payload_seat_amount(NO_SEAT, input.field_mask as u64, new_sequence),
    );
    Ok(())
}

/// Opcode 45: atomically creates AND initializes the settlement-scratch
/// PDA account (`crate::scratch::SETTLEMENT_SCRATCH_LEN` bytes -- the
/// real, computed size, not the compile-time upper bound `scratch.rs`
/// merely asserts it stays under). The scratch PDA can only sign via CPI,
/// so account creation happens here via `SystemProgram::createAccount`
/// with `invoke_signed`, not a top-level client-submitted
/// `SystemProgram.createAccount` (which cannot work: a PDA cannot sign a
/// top-level instruction, only a CPI the owning program itself issues).
/// Doing creation and initialization in one instruction (rather than
/// create-then-separately-call-`InitializeSettlementScratch`) means there
/// is no window where the scratch account exists but is uninitialized.
///
/// Reuses exactly the same seat-ownership check
/// `initialize_settlement_scratch` (opcode 8) already uses, and the same
/// account ordering for the three accounts they share
/// (market/trader/scratch), so a caller already familiar with that
/// instruction needs to learn only the two appended accounts.
///
/// Accounts:
/// 0. `[WRITE]`          the market PDA (read-only use, but required
///                        writable to match `market_data`'s existing
///                        convention, same as `initialize_settlement_scratch`)
/// 1. `[SIGNER]`         the trader (must own the claimed seat)
/// 2. `[WRITE]`          the scratch PDA to create (must not already exist)
/// 3. `[SIGNER, WRITE]`  payer (may be the trader or a sponsor -- never
///                        assumed to be the trader; ownership is proven by
///                        account 1's own signature, not by matching payer)
/// 4. `[]`               the system program
///
/// Data: `[45, seat_index: u16 LE]`.
pub fn create_scratch_account(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    handlers::signer(&accounts[1])?;
    if !accounts[2].is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    handlers::signer(&accounts[3])?;
    if !accounts[3].is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if *accounts[4].address() != pinocchio_system::ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    // No account substitution: every account must be genuinely distinct
    // (a trader signing as their own payer is fine and common -- that's
    // accounts[1] == accounts[3], deliberately still allowed -- but the
    // scratch PDA must never coincide with the market, trader, or payer).
    if accounts[2].address() == accounts[0].address()
        || accounts[2].address() == accounts[1].address()
        || accounts[2].address() == accounts[3].address()
    {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    if accounts[2].data_len() != 0 || accounts[2].lamports() != 0 {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }

    let market_key = *accounts[0].address();
    let trader_key = accounts[1].address().to_bytes();
    let seat_le = seat_index.to_le_bytes();
    let (expected_scratch, scratch_bump) = Address::find_program_address(
        &[
            crate::scratch::SETTLEMENT_SEED,
            market_key.as_ref(),
            &seat_le,
        ],
        program_id,
    );
    if expected_scratch != *accounts[2].address() {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }

    // Exact market + exact seat, reusing the same authoritative on-chain
    // check `initialize_settlement_scratch` already relies on: the seat's
    // own `trader` field, decoded from the market account itself, not the
    // caller's unverified say-so.
    let market = handlers::market_data(&mut accounts[0], program_id)?;
    handlers::initialized_header(market)?;
    if handlers::seat_at(market, seat_index as usize)?.trader != trader_key {
        return Err(custom(StockStreamError::InvalidSeat));
    }

    let bump_slice = [scratch_bump];
    let scratch_seeds = [
        pinocchio::cpi::Seed::from(crate::scratch::SETTLEMENT_SEED),
        pinocchio::cpi::Seed::from(market_key.as_ref()),
        pinocchio::cpi::Seed::from(&seat_le),
        pinocchio::cpi::Seed::from(&bump_slice),
    ];
    let scratch_signer = pinocchio::cpi::Signer::from(&scratch_seeds);

    pinocchio_system::instructions::CreateAccount {
        from: &accounts[3],
        to: &accounts[2],
        lamports: Rent::get()?.try_minimum_balance(crate::scratch::SETTLEMENT_SCRATCH_LEN)?,
        space: crate::scratch::SETTLEMENT_SCRATCH_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(&scratch_signer))?;

    // SAFETY: this instruction just created this exact account via the
    // CPI above -- no other borrow of it exists anywhere in this call.
    let scratch_data = unsafe { accounts[2].borrow_unchecked_mut() };
    let mut view = crate::scratch::SettlementScratchView::new(scratch_data)?;
    view.initialize(market_key.to_bytes(), trader_key, seat_index);
    Ok(())
}
