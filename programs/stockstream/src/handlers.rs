use core::{
    mem::{align_of, size_of, MaybeUninit},
    ptr,
};

use pinocchio::cpi::{invoke_with_bounds, Seed, Signer};
use pinocchio::instruction::{InstructionAccount, InstructionView};
use pinocchio::sysvars::{clock::Clock, Sysvar};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_token::instructions::Transfer;

use crate::{
    book::{
        plan_limit_arenas_into, Arena, MatchLimits, OrderInput, PlanAction, PlannedMatch, Side,
        TimeInForce, TreeKind,
    },
    error::StockStreamError,
    instruction::{PlaceOrderData, StockStreamInstruction},
    risk,
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchView, SETTLEMENT_SCRATCH_LEN,
    },
    state::{
        FillEvent, MarketMode, MarketStateHeader, TraderSeat, FILL_EVENT_CAPACITY,
        FILL_EVENT_OFFSET, FILL_EVENT_SIZE, MARKET_ACCOUNT_SIZE, MARKET_DISCRIMINATOR,
        MARKET_HEADER_SIZE, MAX_TRADER_SEATS, TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE,
    },
};

fn custom(error: StockStreamError) -> ProgramError {
    error.into()
}

fn read_header(data: &[u8]) -> Result<MarketStateHeader, ProgramError> {
    if data.len() < MARKET_HEADER_SIZE {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    let mut value = MaybeUninit::<MarketStateHeader>::uninit();
    // SAFETY: the source length is checked, the destination is exactly the
    // packed header size, and the bytes are validated immediately by callers.
    unsafe {
        ptr::copy_nonoverlapping(
            data.as_ptr(),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<MarketStateHeader>(),
        );
        Ok(value.assume_init())
    }
}

fn write_header(data: &mut [u8], header: &MarketStateHeader) -> ProgramResult {
    if data.len() < MARKET_HEADER_SIZE {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    // SAFETY: the destination is exactly the checked packed header region.
    unsafe {
        ptr::copy_nonoverlapping(
            header as *const MarketStateHeader as *const u8,
            data.as_mut_ptr(),
            size_of::<MarketStateHeader>(),
        );
    }
    Ok(())
}

fn market_data<'a>(
    account: &'a mut AccountView,
    program_id: &Address,
) -> Result<&'a mut [u8], ProgramError> {
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !account.owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }
    if account.data_len() != MARKET_ACCOUNT_SIZE {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    // SAFETY: this is the instruction's sole mutable borrow of the market data.
    unsafe { Ok(account.borrow_unchecked_mut()) }
}

fn initialized_header(data: &[u8]) -> Result<MarketStateHeader, ProgramError> {
    let header = read_header(data)?;
    header
        .validate(data.len())
        .map_err(|_| custom(StockStreamError::InvalidMarketLayout))?;
    if header.initialized == 0 {
        return Err(custom(StockStreamError::MarketNotInitialized));
    }
    Ok(header)
}

/// Copies reviewed registry oracle configuration into a newly initialized
/// market. Registry creation is the only path that may set a market's Pyth
/// Pro feed/channel; trading never accepts either value from callers.
pub(crate) fn configure_market_oracle(
    program_id: &Address,
    market: &mut AccountView,
    feed_id: u32,
    channel: u8,
    price_exponent: i32,
) -> ProgramResult {
    if feed_id == 0 || !(1..=4).contains(&channel) || !(-12..=0).contains(&price_exponent) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let data = market_data(market, program_id)?;
    let mut header = initialized_header(data)?;
    header.price_exponent = price_exponent;
    header.reserved_upgrade[64..68].copy_from_slice(&feed_id.to_le_bytes());
    header.reserved_upgrade[68] = channel;
    write_header(data, &header)
}

fn signer(account: &AccountView) -> ProgramResult {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

const SESSION_DISCRIMINATOR: [u8; 8] = *b"STKSES01";
const SESSION_VERSION: u8 = 1;
const TRADING_SESSION_SIZE: usize = 176;
const SESSION_PLACE: u8 = 1;
const SESSION_CANCEL: u8 = 2;
const SESSION_CANCEL_ALL: u8 = 8;

const SESSION_VERSION_OFFSET: usize = 8;
const SESSION_REVOKED_OFFSET: usize = 9;
const SESSION_OWNER_OFFSET: usize = 10;
const SESSION_SIGNER_OFFSET: usize = 42;
const SESSION_MARKET_OFFSET: usize = 74;
const SESSION_SEAT_OFFSET: usize = 106;
const SESSION_EXPIRY_OFFSET: usize = 108;
const SESSION_ACTIONS_OFFSET: usize = 116;
const SESSION_MAX_ORDER_NOTIONAL_OFFSET: usize = 117;
const SESSION_MAX_CUMULATIVE_NOTIONAL_OFFSET: usize = 125;
const SESSION_USED_CUMULATIVE_NOTIONAL_OFFSET: usize = 133;
const SESSION_MAX_EXPOSURE_OFFSET: usize = 141;
const SESSION_MAX_OPEN_ORDERS_OFFSET: usize = 157;
const SESSION_NONCE_OFFSET: usize = 159;
const SESSION_LAST_USED_NONCE_OFFSET: usize = 167;

fn authorize_trading_actor(
    accounts: &[AccountView],
    market: &[u8],
    seat: &TraderSeat,
    seat_index: usize,
    session_account_index: usize,
    action: u8,
    notional: i128,
    now: u64,
) -> ProgramResult {
    let signer_key = accounts[1].address().to_bytes();
    if signer_key == seat.trader {
        return Ok(());
    }
    if accounts.len() <= session_account_index {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let session = &accounts[session_account_index];
    if !session.is_writable()
        || !session.owned_by(&crate::ID)
        || session.data_len() != TRADING_SESSION_SIZE
        || session.address() == accounts[0].address()
        || session.address() == accounts[1].address()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let bytes = unsafe { session.borrow_unchecked() };
    if bytes[0..8] != SESSION_DISCRIMINATOR
        || bytes[SESSION_VERSION_OFFSET] != SESSION_VERSION
        || bytes[SESSION_REVOKED_OFFSET] != 0
        || bytes[SESSION_OWNER_OFFSET..SESSION_OWNER_OFFSET + 32] != seat.trader
        || bytes[SESSION_SIGNER_OFFSET..SESSION_SIGNER_OFFSET + 32] != signer_key
        || bytes[SESSION_MARKET_OFFSET..SESSION_MARKET_OFFSET + 32] != *market
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if u16::from_le_bytes(
        bytes[SESSION_SEAT_OFFSET..SESSION_SEAT_OFFSET + 2]
            .try_into()
            .unwrap(),
    ) != seat_index as u16
        || bytes[SESSION_ACTIONS_OFFSET] & action == 0
        || u64::from_le_bytes(
            bytes[SESSION_LAST_USED_NONCE_OFFSET..SESSION_LAST_USED_NONCE_OFFSET + 8]
                .try_into()
                .unwrap(),
        ) > u64::from_le_bytes(
            bytes[SESSION_NONCE_OFFSET..SESSION_NONCE_OFFSET + 8]
                .try_into()
                .unwrap(),
        )
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let max_order = u64::from_le_bytes(
        bytes[SESSION_MAX_ORDER_NOTIONAL_OFFSET..SESSION_MAX_ORDER_NOTIONAL_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    let max_cumulative = u64::from_le_bytes(
        bytes[SESSION_MAX_CUMULATIVE_NOTIONAL_OFFSET..SESSION_MAX_CUMULATIVE_NOTIONAL_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    let used = u64::from_le_bytes(
        bytes[SESSION_USED_CUMULATIVE_NOTIONAL_OFFSET..SESSION_USED_CUMULATIVE_NOTIONAL_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    if u64::from_le_bytes(
        bytes[SESSION_EXPIRY_OFFSET..SESSION_EXPIRY_OFFSET + 8]
            .try_into()
            .unwrap(),
    ) <= now
        || notional < 0
        || notional as u128 > max_order as u128
        || (notional as u128).saturating_add(used as u128) > max_cumulative as u128
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    Ok(())
}

fn seat_at(data: &[u8], index: usize) -> Result<TraderSeat, ProgramError> {
    if index >= MAX_TRADER_SEATS {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let start = TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE;
    let end = start + TRADER_SEAT_SIZE;
    if end > data.len() || (data.as_ptr() as usize + start) % align_of::<TraderSeat>() != 0 {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    let mut value = MaybeUninit::<TraderSeat>::uninit();
    // SAFETY: region bounds and alignment were checked; the packed seat has an
    // exact byte representation and is copied without creating an alias.
    unsafe {
        ptr::copy_nonoverlapping(
            data.as_ptr().add(start),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<TraderSeat>(),
        );
        Ok(value.assume_init())
    }
}

fn write_seat(data: &mut [u8], index: usize, seat: &TraderSeat) -> ProgramResult {
    if index >= MAX_TRADER_SEATS {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let start = TRADER_SEAT_OFFSET + index * TRADER_SEAT_SIZE;
    if start + TRADER_SEAT_SIZE > data.len()
        || (data.as_ptr() as usize + start) % align_of::<TraderSeat>() != 0
    {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    // SAFETY: region bounds and alignment were checked and the packed seat is
    // copied as bytes, preserving the account's exact layout.
    unsafe {
        ptr::copy_nonoverlapping(
            seat as *const TraderSeat as *const u8,
            data.as_mut_ptr().add(start),
            size_of::<TraderSeat>(),
        );
    }
    Ok(())
}

fn arena_mut<'a>(data: &'a mut [u8], offset: usize) -> Result<&'a mut Arena, ProgramError> {
    if offset + size_of::<Arena>() > data.len()
        || (data.as_ptr() as usize + offset) % align_of::<Arena>() != 0
    {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    // SAFETY: the layout validator owns the region boundaries, and callers do
    // not create a second reference to this arena during the operation.
    unsafe { Ok(&mut *(data.as_mut_ptr().add(offset) as *mut Arena)) }
}

pub fn dispatch(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction: StockStreamInstruction,
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction {
        StockStreamInstruction::InitializeMarket => initialize_market(program_id, accounts),
        StockStreamInstruction::CreateTraderSeat { seat_index } => {
            create_seat(program_id, accounts, seat_index as usize)
        }
        StockStreamInstruction::CloseTraderSeat { seat_index } => {
            close_seat(program_id, accounts, seat_index as usize)
        }
        StockStreamInstruction::PlaceOrder(order) => place_order(program_id, accounts, order),
        StockStreamInstruction::CancelOrder {
            seat_index,
            order_key,
        } => cancel_order(program_id, accounts, seat_index as usize, order_key),
        StockStreamInstruction::CancelAll {
            seat_index,
            max_cancellations,
        } => cancel_all(program_id, accounts, seat_index as usize, max_cancellations),
        funding @ StockStreamInstruction::UpdateFunding { .. } => {
            update_funding(program_id, accounts, funding)
        }
        StockStreamInstruction::Liquidate {
            seat_index,
            max_quantity,
        } => liquidate(program_id, accounts, seat_index as usize, max_quantity),
        StockStreamInstruction::InitializeSettlementScratch { seat_index } => {
            initialize_settlement_scratch(program_id, accounts, seat_index)
        }
        StockStreamInstruction::InitializeVault => initialize_vault(program_id, accounts),
        StockStreamInstruction::DepositCollateral { seat_index, amount } => {
            deposit_collateral(program_id, accounts, seat_index as usize, amount)
        }
        StockStreamInstruction::WithdrawCollateral { seat_index, amount } => {
            withdraw_collateral(program_id, accounts, seat_index as usize, amount)
        }
        StockStreamInstruction::ConsumeOracleUpdate => {
            consume_oracle_update(program_id, accounts, instruction_data)
        }
        StockStreamInstruction::DelegateMarket { sequence } => {
            delegate_market(program_id, accounts, sequence)
        }
        StockStreamInstruction::CommitMarket { sequence } => {
            commit_market(program_id, accounts, sequence)
        }
        StockStreamInstruction::CommitAndUndelegate { sequence } => {
            commit_and_undelegate(program_id, accounts, sequence)
        }
        StockStreamInstruction::UndelegationCallback { sequence } => {
            undelegation_callback(program_id, accounts, sequence)
        }
        StockStreamInstruction::AuthorizeTradingSession { expires_at, nonce } => {
            authorize_trading_session(program_id, accounts, expires_at, nonce)
        }
        StockStreamInstruction::RevokeTradingSession { nonce } => {
            revoke_trading_session(program_id, accounts, nonce)
        }
        StockStreamInstruction::InitializeExchange => {
            crate::registry::initialize_exchange(program_id, accounts)
        }
        StockStreamInstruction::RegisterStockInstrument { instrument_id } => {
            crate::registry::register_instrument(program_id, accounts, instrument_id)
        }
        StockStreamInstruction::CreatePerpMarket { instrument_id } => {
            crate::registry::create_perp_market(program_id, accounts, instrument_id)
        }
        StockStreamInstruction::UpdateStockInstrument {
            instrument_id,
            pyth_feed_id,
            oracle_channel,
            price_exponent,
        } => crate::registry::update_instrument(
            program_id,
            accounts,
            instrument_id,
            pyth_feed_id,
            oracle_channel,
            price_exponent,
        ),
        StockStreamInstruction::SuspendStockInstrument { instrument_id } => {
            crate::registry::suspend_instrument(program_id, accounts, instrument_id)
        }
        StockStreamInstruction::UpdateMarketRisk {
            initial_margin_bps,
            maintenance_margin_bps,
            maximum_leverage,
        } => update_market_risk(
            program_id,
            accounts,
            initial_margin_bps,
            maintenance_margin_bps,
            maximum_leverage,
        ),
        StockStreamInstruction::TransitionMarket { mode } => {
            transition_market(program_id, accounts, mode)
        }
    }
}

fn update_market_risk(
    program_id: &Address,
    accounts: &mut [AccountView],
    initial: u16,
    maintenance: u16,
    leverage: u32,
) -> ProgramResult {
    if accounts.len() < 2
        || initial == 0
        || maintenance == 0
        || maintenance > initial
        || leverage == 0
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.initial_margin_bps = initial;
    header.maintenance_margin_bps = maintenance;
    header.maximum_leverage = leverage;
    write_header(data, &header)
}

fn transition_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    mode: u8,
) -> ProgramResult {
    if accounts.len() < 2 || mode > MarketMode::Emergency as u8 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.mode = mode;
    write_header(data, &header)
}

fn scratch_data<'a>(
    account: &'a mut AccountView,
    program_id: &Address,
) -> Result<&'a mut [u8], ProgramError> {
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !account.owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }
    if account.data_len() != SETTLEMENT_SCRATCH_LEN {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    // SAFETY: caller holds this account's unique mutable instruction borrow.
    unsafe { Ok(account.borrow_unchecked_mut()) }
}

fn initialize_settlement_scratch(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    if accounts[0].address() == accounts[2].address()
        || accounts[1].address() == accounts[2].address()
    {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let market_key = accounts[0].address().to_bytes();
    let trader_key = accounts[1].address().to_bytes();
    if derive_settlement_scratch(accounts[0].address(), seat_index, program_id)
        != *accounts[2].address()
    {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let market = market_data(&mut accounts[0], program_id)?;
    initialized_header(market)?;
    if seat_at(market, seat_index as usize)?.trader != trader_key {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let scratch = scratch_data(&mut accounts[2], program_id)?;
    let mut view = SettlementScratchView::new(scratch)?;
    let header = view.read_header();
    if header.initialized != 0 {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    view.initialize(market_key, trader_key, seat_index);
    Ok(())
}

fn initialize_market(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().clone();
    initialize_market_account(program_id, &mut accounts[0], &authority, &[0; 32])
}

pub(crate) fn initialize_market_account(
    program_id: &Address,
    market_account: &mut AccountView,
    authority: &Address,
    instrument_id: &[u8; 32],
) -> ProgramResult {
    let market_key = authority.to_bytes();
    let data = market_data(market_account, program_id)?;
    let existing = read_header(data)?;
    if existing.discriminator == MARKET_DISCRIMINATOR && existing.initialized != 0 {
        return Err(custom(StockStreamError::MarketAlreadyInitialized));
    }
    let mut header = MarketStateHeader::empty();
    header.market_authority = market_key;
    header.pause_authority = market_key;
    header.emergency_authority = market_key;
    header.initialized = 1;
    header.mode = crate::state::MarketMode::Paused as u8;
    header.reserved_upgrade[32..64].copy_from_slice(instrument_id);
    header
        .validate(data.len())
        .map_err(|_| custom(StockStreamError::InvalidMarketLayout))?;
    write_header(data, &header)?;
    initialize_arena_bytes(data, header.bid_arena_offset as usize)?;
    initialize_arena_bytes(data, header.ask_arena_offset as usize)
}

fn initialize_arena_bytes(data: &mut [u8], offset: usize) -> ProgramResult {
    let length = size_of::<Arena>();
    if offset + length > data.len() {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    data[offset..offset + length].fill(0);
    data[offset..offset + 4].copy_from_slice(&1u32.to_le_bytes());
    data[offset + 4..offset + 8].copy_from_slice(&u32::MAX.to_le_bytes());
    data[offset + 8..offset + 12].copy_from_slice(&u32::MAX.to_le_bytes());
    data[offset + 24..offset + 28].copy_from_slice(&u32::MAX.to_le_bytes());
    Ok(())
}

const TOKEN_PROGRAM_ID: Address = pinocchio_token::ID;
const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";

fn derive_vault(market: &Address, program_id: &Address) -> Address {
    Address::find_program_address(&[VAULT_SEED, market.as_ref()], program_id).0
}

fn derive_vault_authority(market: &Address, program_id: &Address) -> Address {
    Address::find_program_address(&[VAULT_AUTHORITY_SEED, market.as_ref()], program_id).0
}

fn custody_config(
    header: &MarketStateHeader,
    mint: &Address,
    token_program: &Address,
) -> ProgramResult {
    if header.collateral_mint != mint.to_bytes()
        || header.collateral_token_program != token_program.to_bytes()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if token_program != &TOKEN_PROGRAM_ID || header.reserved_upgrade[1] != 1 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    Ok(())
}

fn initialize_vault(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    if accounts[0].address() == accounts[4].address()
        || accounts[0].address() == accounts[5].address()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if *accounts[3].address() != TOKEN_PROGRAM_ID
        || *accounts[4].address() != derive_vault(accounts[0].address(), program_id)
        || *accounts[5].address() != derive_vault_authority(accounts[0].address(), program_id)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let decimals = {
        let mint = pinocchio_token::state::Mint::from_account_view(&accounts[2])
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        if !mint.is_initialized() {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        mint.decimals()
    };
    let authority = accounts[1].address().to_bytes();
    let mint = accounts[2].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority || header.reserved_upgrade[1] != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.collateral_mint = mint;
    header.collateral_token_program = TOKEN_PROGRAM_ID.to_bytes();
    header.reserved_upgrade[0] = decimals;
    header.reserved_upgrade[1] = 1;
    write_header(data, &header)
}

fn deposit_collateral(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    amount: u64,
) -> ProgramResult {
    if accounts.len() < 7 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_custody_aliases(accounts)?;
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    if market_accounts[0].address() == rest[2].address()
        || market_accounts[0].address() == rest[3].address()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if *rest[3].address() != derive_vault(market_accounts[0].address(), program_id) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let vault_authority = derive_vault_authority(market_accounts[0].address(), program_id);
    let data = market_data(&mut market_accounts[0], program_id)?;
    let header = initialized_header(data)?;
    custody_config(&header, rest[4].address(), rest[5].address())?;
    validate_custody_tokens(&header, &rest[4], &rest[3], &vault_authority)?;
    let mut seat = seat_at(data, seat_index)?;
    if seat.trader != rest[0].address().to_bytes() {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let token_account = pinocchio_token::state::Account::from_account_view(&rest[2])
        .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
    if token_account.mint() != rest[4].address()
        || token_account.owner() != rest[0].address()
        || token_account.amount() < amount
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    seat.available_collateral = seat
        .available_collateral
        .checked_add(amount as i128)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    Transfer::<&AccountView>::new(&rest[2], &rest[3], &rest[0], amount)
        .invoke_with_program(rest[5].address())?;
    write_seat(data, seat_index, &seat)
}

fn withdraw_collateral(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    amount: u64,
) -> ProgramResult {
    if accounts.len() < 7 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_custody_aliases(accounts)?;
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    if *rest[3].address() != derive_vault(market_accounts[0].address(), program_id)
        || *rest[4].address() != derive_vault_authority(market_accounts[0].address(), program_id)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let trader = rest[0].address().to_bytes();
    let market_key = market_accounts[0].address().to_bytes();
    let bump = [Address::find_program_address(&[VAULT_AUTHORITY_SEED, &market_key], program_id).1];
    let data = market_data(&mut market_accounts[0], program_id)?;
    let header = initialized_header(data)?;
    custody_config(&header, rest[2].address(), rest[5].address())?;
    validate_custody_tokens(&header, &rest[2], &rest[3], rest[4].address())?;
    let seat = seat_at(data, seat_index)?;
    if seat.trader != trader || seat.occupancy != 1 || header.oracle_valid != 1 {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let seat = risk::prepare_withdrawal(
        &seat,
        amount,
        header.funding_accumulator,
        header.last_verified_oracle_price as i128,
        header.maintenance_margin_bps,
    )
    .map_err(|_| custom(StockStreamError::RiskViolation))?;
    let destination = pinocchio_token::state::Account::from_account_view(&rest[1])
        .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
    if destination.mint() != rest[2].address() || destination.owner() != rest[0].address() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let seeds = [
        Seed::from(VAULT_AUTHORITY_SEED),
        Seed::from(&market_key),
        Seed::from(&bump),
    ];
    let signer_seeds = [Signer::from(&seeds)];
    Transfer::<&AccountView>::new(&rest[3], &rest[1], &rest[4], amount)
        .invoke_signed_with_program(&signer_seeds, rest[5].address())?;
    write_seat(data, seat_index, &seat)
}

fn validate_custody_aliases(accounts: &[AccountView]) -> ProgramResult {
    if accounts.len() != 7 {
        return Err(ProgramError::InvalidInstructionData);
    }
    for i in 0..7 {
        for j in 0..i {
            if accounts[i].address() == accounts[j].address() {
                return Err(ProgramError::InvalidAccountData);
            }
        }
    }
    Ok(())
}

fn validate_custody_tokens(
    header: &MarketStateHeader,
    mint: &AccountView,
    vault: &AccountView,
    authority: &Address,
) -> ProgramResult {
    if header.reserved_upgrade[2] != 0 {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let mint_state = pinocchio_token::state::Mint::from_account_view(mint)?;
    let vault_state = pinocchio_token::state::Account::from_account_view(vault)?;
    if !mint_state.is_initialized()
        || mint_state.decimals() != header.reserved_upgrade[0]
        || vault_state.mint() != mint.address()
        || vault_state.owner() != authority
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

const PYTH_PROGRAM_ID: Address = Address::new_from_array([
    12, 74, 159, 176, 3, 249, 12, 128, 32, 17, 101, 150, 154, 165, 132, 195, 182, 126, 234, 138,
    69, 43, 85, 3, 6, 14, 175, 224, 214, 116, 116, 91,
]);
const PYTH_STORAGE_ID: Address = Address::new_from_array([
    42, 109, 225, 199, 127, 174, 116, 113, 78, 156, 43, 125, 245, 28, 89, 122, 141, 218, 138, 70,
    61, 251, 135, 64, 90, 171, 220, 10, 61, 0, 238, 25,
]);
const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0; 32]);
const INSTRUCTIONS_SYSVAR_ID: Address = Address::new_from_array([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33,
    86, 117, 165, 219, 186, 203, 95, 8, 0, 0, 0,
]);
const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];
const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;
const MAX_PYTH_MESSAGE: usize = 512;

struct VerifiedOracle {
    feed_id: u32,
    channel: u8,
    price: i64,
    exponent: i16,
    confidence: i64,
    timestamp_us: u64,
    session: i16,
}

fn parse_verified_oracle(message: &[u8]) -> Result<VerifiedOracle, ProgramError> {
    if message.len() < 102
        || u32::from_le_bytes(message[0..4].try_into().unwrap()) != SOLANA_FORMAT_MAGIC
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let payload_len = u16::from_le_bytes(message[100..102].try_into().unwrap()) as usize;
    if payload_len != 60 || message.len() != 102 + payload_len {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let payload = &message[102..];
    if u32::from_le_bytes(payload[0..4].try_into().unwrap()) != PAYLOAD_FORMAT_MAGIC
        || payload[13] != 1
        || payload[18] != 5
        || [
            payload[19],
            payload[28],
            payload[31],
            payload[40],
            payload[43],
        ] != [0, 4, 5, 9, 12]
        || payload[44] != 1
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    Ok(VerifiedOracle {
        timestamp_us: u64::from_le_bytes(payload[4..12].try_into().unwrap()),
        channel: payload[12],
        feed_id: u32::from_le_bytes(payload[14..18].try_into().unwrap()),
        price: i64::from_le_bytes(payload[20..28].try_into().unwrap()),
        exponent: i16::from_le_bytes(payload[29..31].try_into().unwrap()),
        confidence: i64::from_le_bytes(payload[32..40].try_into().unwrap()),
        session: i16::from_le_bytes(payload[41..43].try_into().unwrap()),
    })
}

fn consume_oracle_update(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() != 7 || instruction_data.len() < 104 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let message = &instruction_data[1..];
    if message.len() > MAX_PYTH_MESSAGE
        || !accounts[1].is_signer()
        || !accounts[1].is_writable()
        || !accounts[2].executable()
        || accounts[2].address() != &PYTH_PROGRAM_ID
        || accounts[3].address() != &PYTH_STORAGE_ID
        || !accounts[3].owned_by(&PYTH_PROGRAM_ID)
        || !accounts[4].is_writable()
        || accounts[5].address() != &SYSTEM_PROGRAM_ID
        || accounts[6].address() != &INSTRUCTIONS_SYSVAR_ID
        || accounts[3].address() == accounts[4].address()
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let storage = accounts[3].try_borrow()?;
    if storage.len() < 72 || storage[40..72] != accounts[4].address().to_bytes() {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    drop(storage);

    let mut verify_data = [0u8; 527];
    verify_data[..8].copy_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    verify_data[8..12].copy_from_slice(&(message.len() as u32).to_le_bytes());
    verify_data[12..12 + message.len()].copy_from_slice(message);
    verify_data[12 + message.len()..14 + message.len()].copy_from_slice(&0u16.to_le_bytes());
    verify_data[14 + message.len()] = 0;
    let metas = [
        InstructionAccount::writable_signer(accounts[1].address()),
        InstructionAccount::readonly(accounts[3].address()),
        InstructionAccount::writable(accounts[4].address()),
        InstructionAccount::readonly(accounts[5].address()),
        InstructionAccount::readonly(accounts[6].address()),
    ];
    let cpi_accounts = [
        &accounts[1],
        &accounts[3],
        &accounts[4],
        &accounts[5],
        &accounts[6],
    ];
    invoke_with_bounds::<5, _>(
        &InstructionView {
            program_id: accounts[2].address(),
            accounts: &metas,
            data: &verify_data[..15 + message.len()],
        },
        &cpi_accounts,
    )?;

    let verified = parse_verified_oracle(message)?;
    let now = Clock::get()?.unix_timestamp;
    let timestamp = verified.timestamp_us / 1_000_000;
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let configured_feed = u32::from_le_bytes(header.reserved_upgrade[64..68].try_into().unwrap());
    if configured_feed == 0
        || verified.feed_id != configured_feed
        || verified.channel != header.reserved_upgrade[68]
        || i32::from(verified.exponent) != header.price_exponent
        || verified.price <= 0
        || verified.confidence < 0
        || verified.confidence as u64 > verified.price.unsigned_abs() / 5
        || now < 0
        || timestamp > now as u64 + 2
        || now as u64 > timestamp.saturating_add(10)
        || timestamp <= header.last_verified_oracle_timestamp
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    header.last_verified_oracle_price = verified.price;
    header.last_verified_oracle_timestamp = timestamp;
    header.oracle_valid = 1;
    header.mode = match verified.session {
        0 | 1 | 2 => MarketMode::Open as u8,
        3 | 4 => MarketMode::CloseOnly as u8,
        _ => return Err(custom(StockStreamError::OracleUnavailable)),
    };
    write_header(data, &header)
}

fn validate_hot_accounts(accounts: &[AccountView]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let mut i = 2;
    while i < accounts.len() {
        if !accounts[i].is_writable() {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        let mut j = 2;
        while j < i {
            if accounts[i].address() == accounts[j].address() {
                return Err(custom(StockStreamError::InvalidInstruction));
            }
            j += 1;
        }
        i += 1;
    }
    Ok(())
}

fn delegate_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    validate_hot_accounts(accounts)?;
    let authority = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority || sequence == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.reserved_upgrade[2] = 1;
    header.reserved_upgrade[3..11].copy_from_slice(&sequence.to_le_bytes());
    write_header(data, &header)
}

fn commit_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.reserved_upgrade[2] == 0
        || sequence <= u64::from_le_bytes(header.reserved_upgrade[3..11].try_into().unwrap())
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.reserved_upgrade[3..11].copy_from_slice(&sequence.to_le_bytes());
    write_header(data, &header)
}

fn commit_and_undelegate(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    commit_market(program_id, accounts, sequence)?;
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    header.reserved_upgrade[2] = 2;
    write_header(data, &header)
}

fn undelegation_callback(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    if accounts.len() < 2 || accounts[1].address() != accounts[0].address() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if sequence == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.reserved_upgrade[2] != 2 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.reserved_upgrade[2] = 0;
    header.reserved_upgrade[11..19].copy_from_slice(&sequence.to_le_bytes());
    write_header(data, &header)
}

fn authorize_trading_session(
    program_id: &Address,
    accounts: &mut [AccountView],
    expires_at: u64,
    nonce: u64,
) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let owner = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let session_key = accounts[2].address().to_bytes();
    let session_signer = accounts[3].address().to_bytes();
    if !accounts[2].is_writable()
        || !accounts[2].owned_by(program_id)
        || accounts[2].data_len() != TRADING_SESSION_SIZE
        || session_key == market_key
        || session_key == owner
        || session_key == session_signer
        || session_signer == owner
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = market_data(&mut accounts[0], program_id)?;
    let header = initialized_header(data)?;
    if expires_at <= header.last_verified_oracle_timestamp {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let mut found = None;
    let mut index = 0;
    while index < MAX_TRADER_SEATS {
        let seat = seat_at(data, index)?;
        if seat.occupancy == 1 && seat.trader == owner {
            found = Some(index as u16);
            break;
        }
        index += 1;
    }
    let Some(seat_index) = found else {
        return Err(custom(StockStreamError::InvalidSeat));
    };
    let session = unsafe { accounts[2].borrow_unchecked_mut() };
    if session[0..8] == SESSION_DISCRIMINATOR && session[SESSION_REVOKED_OFFSET] == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    session.fill(0);
    session[0..8].copy_from_slice(&SESSION_DISCRIMINATOR);
    session[SESSION_VERSION_OFFSET] = SESSION_VERSION;
    session[SESSION_OWNER_OFFSET..SESSION_OWNER_OFFSET + 32].copy_from_slice(&owner);
    // The session signer stays client-held; the program only stores its public
    // key and policy, never a signing secret.
    session[SESSION_SIGNER_OFFSET..SESSION_SIGNER_OFFSET + 32].copy_from_slice(&session_signer);
    session[SESSION_MARKET_OFFSET..SESSION_MARKET_OFFSET + 32].copy_from_slice(&market_key);
    session[SESSION_SEAT_OFFSET..SESSION_SEAT_OFFSET + 2]
        .copy_from_slice(&seat_index.to_le_bytes());
    session[SESSION_EXPIRY_OFFSET..SESSION_EXPIRY_OFFSET + 8]
        .copy_from_slice(&expires_at.to_le_bytes());
    session[SESSION_ACTIONS_OFFSET] = SESSION_PLACE | SESSION_CANCEL | SESSION_CANCEL_ALL;
    session[SESSION_MAX_ORDER_NOTIONAL_OFFSET..SESSION_MAX_ORDER_NOTIONAL_OFFSET + 8]
        .copy_from_slice(&u64::MAX.to_le_bytes());
    session[SESSION_MAX_CUMULATIVE_NOTIONAL_OFFSET..SESSION_MAX_CUMULATIVE_NOTIONAL_OFFSET + 8]
        .copy_from_slice(&u64::MAX.to_le_bytes());
    session[SESSION_MAX_EXPOSURE_OFFSET..SESSION_MAX_EXPOSURE_OFFSET + 16]
        .copy_from_slice(&i128::MAX.to_le_bytes());
    session[SESSION_MAX_OPEN_ORDERS_OFFSET..SESSION_MAX_OPEN_ORDERS_OFFSET + 2]
        .copy_from_slice(&u16::MAX.to_le_bytes());
    session[SESSION_NONCE_OFFSET..SESSION_NONCE_OFFSET + 8].copy_from_slice(&nonce.to_le_bytes());
    Ok(())
}

fn revoke_trading_session(
    program_id: &Address,
    accounts: &mut [AccountView],
    nonce: u64,
) -> ProgramResult {
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let owner = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let session_key = accounts[2].address().to_bytes();
    if !accounts[2].is_writable()
        || !accounts[2].owned_by(program_id)
        || accounts[2].data_len() != TRADING_SESSION_SIZE
        || session_key == market_key
        || session_key == owner
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    let session = unsafe { accounts[2].borrow_unchecked_mut() };
    if session[0..8] != SESSION_DISCRIMINATOR
        || session[SESSION_VERSION_OFFSET] != SESSION_VERSION
        || session[SESSION_OWNER_OFFSET..SESSION_OWNER_OFFSET + 32] != owner
        || session[SESSION_MARKET_OFFSET..SESSION_MARKET_OFFSET + 32] != market_key
        || u64::from_le_bytes(
            session[SESSION_NONCE_OFFSET..SESSION_NONCE_OFFSET + 8]
                .try_into()
                .unwrap(),
        ) != nonce
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    session[SESSION_REVOKED_OFFSET] = 1;
    Ok(())
}

fn create_seat(program_id: &Address, accounts: &mut [AccountView], index: usize) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let header = initialized_header(data)?;
    if index >= MAX_TRADER_SEATS {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let mut i = 0;
    while i < MAX_TRADER_SEATS {
        let seat = seat_at(data, i)?;
        if !seat.is_empty() && seat.trader == trader {
            return Err(custom(StockStreamError::SeatOccupied));
        }
        i += 1;
    }
    let current = seat_at(data, index)?;
    if !current.is_empty() {
        return Err(custom(StockStreamError::SeatOccupied));
    }
    let mut seat = TraderSeat::empty();
    seat.occupancy = 1;
    seat.trader = trader;
    seat.sequence = header.global_event_sequence;
    write_seat(data, index, &seat)
}

fn close_seat(program_id: &Address, accounts: &mut [AccountView], index: usize) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    let seat = seat_at(data, index)?;
    if seat.trader != trader {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    if !seat.can_close() {
        return Err(custom(StockStreamError::SeatNotEmpty));
    }
    write_seat(data, index, &TraderSeat::empty())
}

#[inline(never)]
fn place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    if accounts[0].address() == accounts[2].address()
        || accounts[1].address() == accounts[2].address()
    {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let market_address = accounts[0].address().to_bytes();
    let trader = accounts[1].address().to_bytes();
    let expected_scratch =
        derive_settlement_scratch(accounts[0].address(), order.seat_index, program_id);
    if expected_scratch != *accounts[2].address() {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let (session_authorized, seat_owner) = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, order.seat_index as usize)?;
        authorize_trading_actor(
            accounts,
            &market_address,
            &snapshot_seat,
            order.seat_index as usize,
            3,
            SESSION_PLACE,
            0,
            snapshot_header.last_verified_oracle_timestamp,
        )?;
        (snapshot_seat.trader != trader, snapshot_seat.trader)
    };
    let (market_accounts, scratch_accounts) = accounts.split_at_mut(2);
    let scratch_bytes = scratch_data(&mut scratch_accounts[0], program_id)?;
    let mut scratch = SettlementScratchView::new(scratch_bytes)?;
    let data = market_data(&mut market_accounts[0], program_id)?;
    let header = initialized_header(data)?;
    if header.mode != MarketMode::Open as u8 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if (seat_at(data, order.seat_index as usize)?.trader != trader && !session_authorized)
        || order.quantity == 0
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if header.oracle_valid == 0 || header.last_verified_oracle_price <= 0 {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    if order.side > 1 || order.tree > 1 || order.flags & !7 != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let side = if order.side == Side::Bid as u8 {
        Side::Bid
    } else {
        Side::Ask
    };
    let tree = if order.tree == TreeKind::Fixed as u8 {
        TreeKind::Fixed
    } else {
        TreeKind::OraclePegged
    };
    let is_post_only = order.flags & 1 != 0;
    let tif = if order.flags & 2 != 0 {
        TimeInForce::ImmediateOrCancel
    } else {
        TimeInForce::GoodTilCancelled
    };
    let current_price = if tree == TreeKind::Fixed {
        order.price_or_offset
    } else {
        header
            .last_verified_oracle_price
            .checked_add(order.price_or_offset)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
    };
    if current_price <= 0 || order.quantity == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let mut taker = seat_at(data, order.seat_index as usize)?;
    let taker_before = taker;
    let mut occupied = [false; MAX_TRADER_SEATS];
    let mut occupied_index = 0usize;
    while occupied_index < MAX_TRADER_SEATS {
        occupied[occupied_index] = !seat_at(data, occupied_index)?.is_empty();
        occupied_index += 1;
    }
    {
        let bids = arena_mut(data, crate::state::BID_ARENA_OFFSET)?;
        bids.validate().map_err(book_error)?;
        bids.validate_owner_occupancy(&occupied)
            .map_err(book_error)?;
        let asks = arena_mut(data, crate::state::ASK_ARENA_OFFSET)?;
        asks.validate().map_err(book_error)?;
        asks.validate_owner_occupancy(&occupied)
            .map_err(book_error)?;
    }
    if order.flags & 4 != 0
        && ((side == Side::Bid && taker.base_position >= 0)
            || (side == Side::Ask && taker.base_position <= 0))
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    risk::settle_funding(&mut taker, header.funding_accumulator).map_err(risk_error)?;
    let order_notional =
        risk::notional(order.quantity as i128, current_price as i128).map_err(risk_error)?;
    let required =
        risk::initial_margin(order_notional, header.initial_margin_bps).map_err(risk_error)?;
    if risk::available_margin(
        &taker,
        header.last_verified_oracle_price as i128,
        header.initial_margin_bps,
    )
    .map_err(risk_error)?
        < required
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let sequence = header
        .global_order_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    let input = OrderInput {
        side,
        tree,
        owner: order.seat_index as u32,
        price_or_offset: order.price_or_offset,
        sequence,
        quantity: order.quantity,
        expires_at: order.expires_at,
        peg_limit: order.peg_limit,
        client_order_id: order.client_order_id,
        time_in_force: tif,
        post_only: is_post_only,
    };
    let now = header.last_verified_oracle_timestamp;
    let scratch_before = scratch.read_header();
    // Scratch is bound to the trader seat's owner, not the delegated session
    // signer. A session must not be able to redirect a seat's working account.
    let nonce = scratch.begin(market_address, seat_owner, order.seat_index)?;
    {
        let planned = scratch.plan_mut();
        unsafe {
            let bids = &*(data.as_ptr().add(crate::state::BID_ARENA_OFFSET) as *const Arena);
            let asks = &*(data.as_ptr().add(crate::state::ASK_ARENA_OFFSET) as *const Arena);
            plan_limit_arenas_into(
                bids,
                asks,
                input,
                Some(header.last_verified_oracle_price),
                now,
                MatchLimits {
                    max_fills: crate::book::MAX_FILLS_PER_INSTRUCTION as u8,
                    max_invalid_removals: 4,
                    max_expired_removals: 2,
                },
                planned,
            )
            .map_err(book_error)?;
        }
        planned.expected_oracle_price = header.last_verified_oracle_price;
        planned.expected_oracle_timestamp = header.last_verified_oracle_timestamp;
        planned.expected_funding_accumulator = header.funding_accumulator;
        planned.expected_event_sequence = header.global_event_sequence;
        planned.expected_order_sequence = sequence;
    }
    plan_seat_results(data, &mut scratch, input, header, &taker)?;
    validate_settlement_plan(data, &scratch, input, header, &taker_before)?;
    if scratch.plan().post_only_rejected {
        scratch.abort_to(&scratch_before);
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    apply_settlement_plan(data, scratch.plan())?;
    if scratch.plan().remaining > 0
        && input.time_in_force == TimeInForce::GoodTilCancelled
        && !scratch.plan().post_only_rejected
    {
        let mut resting = input;
        resting.quantity = scratch.plan().remaining;
        let side_offset = if input.side == Side::Bid {
            crate::state::BID_ARENA_OFFSET
        } else {
            crate::state::ASK_ARENA_OFFSET
        };
        arena_mut(data, side_offset)?
            .insert(resting.tree, resting.leaf().map_err(book_error)?)
            .map_err(book_error)?;
    }
    apply_scratch_results(data, &scratch)?;
    let scratch_result = scratch.read_header();
    let mut updated = header;
    updated.global_order_sequence = scratch_result.final_order_sequence;
    updated.global_event_sequence = scratch_result.final_event_sequence;
    updated.current_open_interest = scratch_result.open_interest_after;
    write_header(data, &updated)?;
    let mut scratch_header = scratch.read_header();
    scratch_header.plan_nonce = nonce;
    scratch_header.status = ScratchStatus::Ready as u8;
    scratch.write_header(&scratch_header);
    scratch.clear();
    Ok(())
}

/// Computes every seat, margin, event and market result before the arena is
/// touched. `TraderSeat` values live in scratch slots rather than an SBF stack
/// array; a slot is allocated once per participating maker plus the taker.
#[inline(never)]
fn plan_seat_results(
    data: &[u8],
    scratch: &mut SettlementScratchView,
    input: OrderInput,
    header: MarketStateHeader,
    taker_initial: &TraderSeat,
) -> ProgramResult {
    let mut taker = *taker_initial;
    scratch.write_seat_result(0, &taker)?;
    scratch.set_seat_result_index(0, input.owner as u16)?;

    let mut fill_index = 0usize;
    while fill_index < scratch.plan().fill_count as usize {
        let fill = scratch.plan().fills[fill_index];
        let scratch_header = scratch.read_header();
        let mut slot = 1usize;
        while slot < scratch_header.seat_result_count as usize
            && scratch_header.seat_result_indices[slot] != fill.maker as u16
        {
            slot += 1;
        }
        if slot == scratch_header.seat_result_count as usize {
            if slot >= crate::book::MAX_FILLS_PER_INSTRUCTION + 1 {
                return Err(custom(StockStreamError::RiskViolation));
            }
            let mut maker = seat_at(data, fill.maker as usize)?;
            risk::settle_funding(&mut maker, header.funding_accumulator).map_err(risk_error)?;
            scratch.write_seat_result(slot, &maker)?;
            scratch.set_seat_result_index(slot, fill.maker as u16)?;
        }
        let mut maker = scratch.seat_result(slot)?;
        let signed = if input.side == Side::Bid {
            fill.quantity as i128
        } else {
            -(fill.quantity as i128)
        };
        risk::apply_fill(
            &mut maker,
            -signed,
            fill.price as i128,
            header.maker_fee_bps,
        )
        .map_err(risk_error)?;
        risk::apply_fill(&mut taker, signed, fill.price as i128, header.taker_fee_bps)
            .map_err(risk_error)?;
        let release = risk::initial_margin(
            risk::notional(fill.quantity as i128, fill.price as i128).map_err(risk_error)?,
            header.initial_margin_bps,
        )
        .map_err(risk_error)?;
        maker.reserved_margin = maker
            .reserved_margin
            .checked_sub(release)
            .ok_or(custom(StockStreamError::RiskViolation))?;
        if fill.maker_remaining == 0 {
            maker.open_order_count = maker
                .open_order_count
                .checked_sub(1)
                .ok_or(custom(StockStreamError::RiskViolation))?;
        }
        if input.side == Side::Bid {
            maker.open_ask_exposure = maker
                .open_ask_exposure
                .checked_sub(fill.quantity as i128)
                .ok_or(custom(StockStreamError::RiskViolation))?;
        } else {
            maker.open_bid_exposure = maker
                .open_bid_exposure
                .checked_sub(fill.quantity as i128)
                .ok_or(custom(StockStreamError::RiskViolation))?;
        }
        scratch.write_seat_result(slot, &maker)?;
        let event = FillEvent {
            sequence: header
                .global_event_sequence
                .checked_add(fill_index as u64)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
            maker_seat: fill.maker,
            taker_seat: fill.taker,
            price: fill.price,
            quantity: fill.quantity,
            maker_client_order_id: fill.maker_client_order_id,
            timestamp: header.last_verified_oracle_timestamp,
            reserved: [0; 16],
        };
        scratch.write_event(fill_index, &event)?;
        fill_index += 1;
    }
    if scratch.plan().remaining > 0 && input.time_in_force == TimeInForce::GoodTilCancelled {
        let price = match input.tree {
            TreeKind::Fixed => input.price_or_offset,
            TreeKind::OraclePegged => header
                .last_verified_oracle_price
                .checked_add(input.price_or_offset)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
        };
        let reserve = risk::initial_margin(
            risk::notional(scratch.plan().remaining as i128, price as i128).map_err(risk_error)?,
            header.initial_margin_bps,
        )
        .map_err(risk_error)?;
        taker.reserved_margin = taker
            .reserved_margin
            .checked_add(reserve)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        taker.open_order_count = taker
            .open_order_count
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        if input.side == Side::Bid {
            taker.open_bid_exposure = taker
                .open_bid_exposure
                .checked_add(scratch.plan().remaining as i128)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        } else {
            taker.open_ask_exposure = taker
                .open_ask_exposure
                .checked_add(scratch.plan().remaining as i128)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        }
    }
    scratch.write_seat_result(0, &taker)?;
    let scratch_header = scratch.read_header();
    let mut total = 0i128;
    let mut index = 0usize;
    while index < MAX_TRADER_SEATS {
        let mut seat = seat_at(data, index)?;
        let mut slot = 0usize;
        while slot < scratch_header.seat_result_count as usize {
            if scratch_header.seat_result_indices[slot] as usize == index {
                seat = scratch.seat_result(slot)?;
                break;
            }
            slot += 1;
        }
        total = total
            .checked_add(
                seat.base_position
                    .checked_abs()
                    .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
            )
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        index += 1;
    }
    let mut result = scratch.read_header();
    result.fill_count = scratch.plan().fill_count;
    result.event_count = scratch.plan().fill_count;
    result.invalid_removal_count = scratch.plan().invalid_removed;
    result.expired_removal_count = scratch.plan().expired_removed;
    result.expected_order_sequence = header.global_order_sequence;
    result.expected_event_sequence = header.global_event_sequence;
    result.expected_oracle_timestamp = header.last_verified_oracle_timestamp;
    result.expected_funding_timestamp = header.last_funding_timestamp;
    result.open_interest_after = total / 2;
    result.final_order_sequence = input.sequence;
    result.final_event_sequence = header
        .global_event_sequence
        .checked_add(scratch.plan().fill_count as u64)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    result.status = ScratchStatus::Ready as u8;
    scratch.write_header(&result);
    Ok(())
}

fn apply_scratch_results(data: &mut [u8], scratch: &SettlementScratchView) -> ProgramResult {
    let header = scratch.read_header();
    if header.status != ScratchStatus::Ready as u8 {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let mut slot = 0usize;
    while slot < header.seat_result_count as usize {
        write_seat(
            data,
            header.seat_result_indices[slot] as usize,
            &scratch.seat_result(slot)?,
        )?;
        slot += 1;
    }
    let mut event = 0usize;
    while event < header.event_count as usize {
        let value = scratch.event(event)?;
        let start =
            FILL_EVENT_OFFSET + (value.sequence as usize % FILL_EVENT_CAPACITY) * FILL_EVENT_SIZE;
        let dst = &mut data[start..start + FILL_EVENT_SIZE];
        // SAFETY: event ring range is validated by the fixed market layout.
        unsafe {
            ptr::copy_nonoverlapping(
                (&value as *const FillEvent).cast::<u8>(),
                dst.as_mut_ptr(),
                FILL_EVENT_SIZE,
            );
        }
        event += 1;
    }
    Ok(())
}

fn apply_settlement_plan(data: &mut [u8], plan: &PlannedMatch) -> ProgramResult {
    let mut index = 0usize;
    while index < plan.action_count as usize {
        let action = plan.actions[index];
        let offset = if action.side == Side::Bid {
            crate::state::BID_ARENA_OFFSET
        } else {
            crate::state::ASK_ARENA_OFFSET
        };
        let arena = arena_mut(data, offset)?;
        let handle = arena.find(action.tree, action.key).map_err(book_error)?;
        if handle != action.handle {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        if action.remove {
            // SAFETY: validate_settlement_plan checked the exact leaf identity
            // and all branch preconditions before this apply phase began.
            unsafe { arena.remove_validated(action.tree, action.key) };
        } else {
            // SAFETY: the plan validator checked the leaf tag and handle.
            unsafe { arena.apply_leaf_quantity_validated(action.handle, action.new_quantity) };
        }
        index += 1;
    }
    Ok(())
}

fn validate_settlement_plan(
    data: &[u8],
    scratch: &SettlementScratchView,
    order: OrderInput,
    header: MarketStateHeader,
    taker_before: &TraderSeat,
) -> ProgramResult {
    let current_header = read_header(data)?;
    if current_header.version != header.version
        || current_header.mode != header.mode
        || current_header.oracle_valid != header.oracle_valid
        || current_header.last_verified_oracle_price != header.last_verified_oracle_price
        || current_header.last_verified_oracle_timestamp != header.last_verified_oracle_timestamp
        || current_header.funding_accumulator != header.funding_accumulator
        || current_header.last_funding_timestamp != header.last_funding_timestamp
        || current_header.global_order_sequence != header.global_order_sequence
        || current_header.global_event_sequence != header.global_event_sequence
        || current_header.current_open_interest != header.current_open_interest
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let scratch_header = scratch.read_header();
    let plan = scratch.plan();
    if scratch_header.status != ScratchStatus::Ready as u8
        || scratch_header.expected_order_sequence != header.global_order_sequence
        || scratch_header.expected_event_sequence != header.global_event_sequence
        || scratch_header.expected_oracle_timestamp != header.last_verified_oracle_timestamp
        || scratch_header.expected_funding_timestamp != header.last_funding_timestamp
        || scratch_header.fill_count != plan.fill_count
        || scratch_header.event_count != plan.fill_count
    {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    if plan.expected_oracle_price != header.last_verified_oracle_price
        || plan.expected_oracle_timestamp != header.last_verified_oracle_timestamp
        || plan.expected_funding_accumulator != header.funding_accumulator
        || plan.expected_event_sequence != header.global_event_sequence
        || plan.expected_order_sequence
            != header
                .global_order_sequence
                .checked_add(1)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?
        || seat_at(data, order.owner as usize)?.trader != taker_before.trader
        || seat_at(data, order.owner as usize)?.available_collateral
            != taker_before.available_collateral
        || seat_at(data, order.owner as usize)?.base_position != taker_before.base_position
        || seat_at(data, order.owner as usize)?.reserved_margin != taker_before.reserved_margin
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let mut removed_by_side = [0u32; 2];
    let mut index = 0usize;
    while index < plan.action_count as usize {
        let action: PlanAction = plan.actions[index];
        let offset = if action.side == Side::Bid {
            crate::state::BID_ARENA_OFFSET
        } else {
            crate::state::ASK_ARENA_OFFSET
        };
        let arena = unsafe { &*(data.as_ptr().add(offset) as *const Arena) };
        let handle = arena.find(action.tree, action.key).map_err(book_error)?;
        if handle != action.handle {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        let leaf = arena.leaf(handle).map_err(book_error)?;
        if leaf.owner != action.owner || leaf.quantity != action.expected_quantity {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        if action.remove {
            removed_by_side[if leaf.side == Side::Bid as u8 { 0 } else { 1 }] += 1;
        }
        index += 1;
    }
    if plan.remaining > 0 && order.time_in_force == TimeInForce::GoodTilCancelled {
        let leaf = order.leaf().map_err(book_error)?;
        let side = if order.side == Side::Bid {
            Side::Bid
        } else {
            Side::Ask
        };
        let arena = unsafe {
            &*(data.as_ptr().add(if side == Side::Bid {
                crate::state::BID_ARENA_OFFSET
            } else {
                crate::state::ASK_ARENA_OFFSET
            }) as *const Arena)
        };
        arena
            .can_insert(order.tree, leaf.key, removed_by_side[side as usize])
            .map_err(book_error)?;
        let _ = risk::initial_margin(
            risk::notional(plan.remaining as i128, order.price_or_offset as i128)
                .map_err(risk_error)?,
            header.initial_margin_bps,
        )
        .map_err(risk_error)?;
    }
    Ok(())
}

/// Native account tests use this boundary to prove a scratch plan cannot be
/// applied after the market changes. It is not an instruction and therefore
/// cannot create a deferred plan/apply transaction flow.
#[doc(hidden)]
pub fn validate_planned_settlement_for_test(
    data: &[u8],
    scratch: &SettlementScratchView,
    order: OrderInput,
    header: MarketStateHeader,
    taker_before: &TraderSeat,
) -> ProgramResult {
    validate_settlement_plan(data, scratch, order, header, taker_before)
}

fn cancel_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    order_key: u128,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let session_authorized = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, seat_index)?;
        authorize_trading_actor(
            accounts,
            accounts[0].address().as_ref(),
            &snapshot_seat,
            seat_index,
            2,
            SESSION_CANCEL,
            0,
            snapshot_header.last_verified_oracle_timestamp,
        )?;
        snapshot_seat.trader != trader
    };
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    if seat_at(data, seat_index)?.trader != trader && !session_authorized {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let bid_result = {
        let bid = arena_mut(data, crate::state::BID_ARENA_OFFSET)?;
        bid.remove_owned(crate::book::TreeKind::Fixed, order_key, seat_index as u32)
    };
    let removed = match bid_result {
        Ok(leaf) => Ok(leaf),
        Err(_) => {
            let ask = arena_mut(data, crate::state::ASK_ARENA_OFFSET)?;
            ask.remove_owned(crate::book::TreeKind::Fixed, order_key, seat_index as u32)
        }
    };
    if let Ok(leaf) = removed {
        let mut seat = seat_at(data, seat_index)?;
        seat.open_order_count = seat.open_order_count.saturating_sub(1);
        let price = leaf.price_or_offset;
        if price > 0 {
            let release = risk::initial_margin(
                risk::notional(leaf.quantity as i128, price as i128).map_err(risk_error)?,
                initialized_header(data)?.initial_margin_bps,
            )
            .map_err(risk_error)?;
            seat.reserved_margin = seat.reserved_margin.saturating_sub(release);
        }
        write_seat(data, seat_index, &seat)?;
        return Ok(());
    }
    Err(custom(StockStreamError::InvalidInstruction))
}

fn update_funding(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction: StockStreamInstruction,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority {
        return Err(ProgramError::IllegalOwner);
    }
    let StockStreamInstruction::UpdateFunding {
        accumulator,
        timestamp,
    } = instruction
    else {
        return Err(ProgramError::InvalidInstructionData);
    };
    if timestamp < header.last_funding_timestamp || accumulator < header.funding_accumulator {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.funding_accumulator = accumulator;
    header.last_funding_timestamp = timestamp;
    write_header(data, &header)
}

fn liquidate(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    max_quantity: u64,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let header = initialized_header(data)?;
    if header.oracle_valid == 0 || authority != header.emergency_authority {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let mut seat = seat_at(data, seat_index)?;
    if !risk::is_liquidatable(
        &seat,
        header.last_verified_oracle_price as i128,
        header.maintenance_margin_bps,
    )
    .map_err(risk_error)?
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let quantity = risk::partial_liquidation_quantity(
        &seat,
        header.last_verified_oracle_price as i128,
        header.maintenance_margin_bps,
    )
    .map_err(risk_error)?
    .min(max_quantity as i128);
    let signed = if seat.base_position > 0 {
        -quantity
    } else {
        quantity
    };
    risk::apply_fill(
        &mut seat,
        signed,
        header.last_verified_oracle_price as i128,
        header.liquidation_fee_bps,
    )
    .map_err(risk_error)?;
    risk::set_liquidation_state(
        &mut seat,
        header.last_verified_oracle_price as i128,
        header.maintenance_margin_bps,
    )
    .map_err(risk_error)?;
    write_seat(data, seat_index, &seat)
}

fn risk_error(error: risk::RiskError) -> ProgramError {
    match error {
        risk::RiskError::Overflow => custom(StockStreamError::ArithmeticOverflow),
        _ => custom(StockStreamError::RiskViolation),
    }
}

fn book_error(_error: crate::book::BookError) -> ProgramError {
    custom(StockStreamError::InvalidInstruction)
}

fn cancel_all(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    max: u8,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let session_authorized = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, seat_index)?;
        authorize_trading_actor(
            accounts,
            accounts[0].address().as_ref(),
            &snapshot_seat,
            seat_index,
            2,
            SESSION_CANCEL_ALL,
            0,
            snapshot_header.last_verified_oracle_timestamp,
        )?;
        snapshot_seat.trader != trader
    };
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    if seat_at(data, seat_index)?.trader != trader && !session_authorized {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    let bid = arena_mut(data, crate::state::BID_ARENA_OFFSET)?;
    let first = bid
        .cancel_owner_summary(seat_index as u32, max)
        .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
    let mut total = first;
    if first.count < max {
        let ask = arena_mut(data, crate::state::ASK_ARENA_OFFSET)?;
        let second = ask
            .cancel_owner_summary(seat_index as u32, max - first.count)
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        total.count = total.count.saturating_add(second.count);
        total.bid_quantity = total.bid_quantity.saturating_add(second.bid_quantity);
        total.ask_quantity = total.ask_quantity.saturating_add(second.ask_quantity);
        total.reserved_notional = total
            .reserved_notional
            .saturating_add(second.reserved_notional);
    }
    let mut seat = seat_at(data, seat_index)?;
    seat.open_order_count = seat.open_order_count.saturating_sub(total.count as u32);
    seat.open_bid_exposure = seat
        .open_bid_exposure
        .saturating_sub(total.bid_quantity as i128);
    seat.open_ask_exposure = seat
        .open_ask_exposure
        .saturating_sub(total.ask_quantity as i128);
    let header = initialized_header(data)?;
    let released = risk::initial_margin(
        total.reserved_notional.min(i128::MAX as u128) as i128,
        header.initial_margin_bps,
    )
    .map_err(risk_error)?;
    seat.reserved_margin = seat.reserved_margin.saturating_sub(released);
    write_seat(data, seat_index, &seat)?;
    Ok(())
}
