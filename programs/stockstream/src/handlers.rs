use core::{
    mem::{align_of, size_of, MaybeUninit},
    ptr,
};

use pinocchio::cpi::{invoke_with_bounds, Seed, Signer};
use pinocchio::instruction::{InstructionAccount, InstructionView};
use pinocchio::sysvars::instructions::Instructions;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
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
        FillEvent, MarketMode, MarketStateHeader, ReconciliationStatus, TraderSeat,
        FILL_EVENT_CAPACITY, FILL_EVENT_OFFSET, FILL_EVENT_SIZE, MARKET_ACCOUNT_SIZE,
        MARKET_DISCRIMINATOR, MARKET_HEADER_SIZE, MAX_TRADER_SEATS, TRADER_SEAT_OFFSET,
        TRADER_SEAT_SIZE,
    },
};

pub(crate) fn custom(error: StockStreamError) -> ProgramError {
    error.into()
}

pub(crate) fn read_header(data: &[u8]) -> Result<MarketStateHeader, ProgramError> {
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

pub(crate) fn write_header(data: &mut [u8], header: &MarketStateHeader) -> ProgramResult {
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

pub(crate) fn market_data<'a>(
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

pub(crate) fn initialized_header(data: &[u8]) -> Result<MarketStateHeader, ProgramError> {
    let header = read_header(data)?;
    header
        .validate(data.len())
        .map_err(|_| custom(StockStreamError::InvalidMarketLayout))?;
    if header.initialized == 0 {
        return Err(custom(StockStreamError::MarketNotInitialized));
    }
    Ok(header)
}

#[path = "handlers_oracle.rs"]
mod oracle;
pub(crate) use oracle::configure_market_oracle;

pub(crate) fn signer(account: &AccountView) -> ProgramResult {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

/// The live Rent sysvar on-chain; the well-known default genesis rent rate
/// (`pinocchio::sysvars::rent::DEFAULT_LAMPORTS_PER_BYTE`) off the SBF
/// target, where the sysvar syscall is unavailable
/// (`ProgramError::UnsupportedSysvar`). Every live Solana cluster still uses
/// this exact default; this only changes CreateAccount-CPI-dependent
/// handlers (currently `authorize_trading_session`) from being completely
/// untestable off-chain to being testable using the same rent-exempt
/// minimum a real cluster would require.
/// The live Clock sysvar's `unix_timestamp` on-chain; a fixed sentinel off
/// the SBF target, where the sysvar syscall is unavailable (host tests
/// running `Clock::get()` always observe `ProgramError::UnsupportedSysvar`,
/// since the syscall stub returns a pointer value instead of the `SUCCESS`
/// code pinocchio checks for). `tests/pyth_oracle.rs` builds its fixture
/// timestamps relative to this same constant.
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
pub const OFF_CHAIN_TEST_NOW: i64 = 0; // unused on-chain; keeps the constant defined everywhere.
#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
pub const OFF_CHAIN_TEST_NOW: i64 = 1_700_000_000;

pub(crate) fn current_unix_timestamp() -> Result<i64, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        Ok(Clock::get()?.unix_timestamp)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        Ok(OFF_CHAIN_TEST_NOW)
    }
}

fn current_rent() -> Result<pinocchio::sysvars::rent::Rent, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        pinocchio::sysvars::rent::Rent::get()
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        pinocchio::sysvars::rent::Rent::from_bytes(
            &pinocchio::sysvars::rent::DEFAULT_LAMPORTS_PER_BYTE.to_le_bytes(),
        )
    }
}

use crate::session::{
    self, TradingSession, SESSION_ACTION_CANCEL, SESSION_ACTION_CANCEL_ALL, SESSION_ACTION_PLACE,
    SESSION_ACTION_REDUCE_ONLY_CLOSE, SESSION_ACTION_REPLACE,
};

/// Validates a scoped-session-authorized trading action against the
/// dedicated `TradingSession` PDA, or, if the transaction's own signer is
/// the seat's actual owner, treats it as a main-wallet action (which does
/// not consume a session nonce at all).
///
/// `required_actions` is a bitmask; the session's `actions` allowlist must
/// intersect it. `resulting_exposure` is the caller-computed absolute
/// position size *after* this action would apply (not the current one),
/// since the point of the exposure cap is bounding what the action is about
/// to permit, not what already exists.
///
/// Returns `Ok(Some(session))` when a session authorized the action (the
/// caller must later call `consume_session_action` on success), or
/// `Ok(None)` for a main-wallet action.
#[allow(clippy::too_many_arguments)]
fn authorize_trading_actor(
    accounts: &[AccountView],
    market: &[u8; 32],
    seat: &TraderSeat,
    seat_index: u16,
    session_account_index: usize,
    required_actions: u8,
    notional: i128,
    resulting_exposure: u128,
    action_nonce: u64,
    now: u64,
) -> Result<Option<TradingSession>, ProgramError> {
    let signer_addr = *accounts[1].address();
    let signer_key = signer_addr.to_bytes();
    if signer_key == seat.trader {
        // Main-wallet authorizations are transaction-signature protected and
        // intentionally do not share the scoped-session nonce namespace.
        if action_nonce != 0 {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        return Ok(None);
    }
    signer(&accounts[1])?;
    if accounts.len() <= session_account_index {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if accounts[session_account_index].address() == accounts[0].address()
        || accounts[session_account_index].address() == &signer_addr
    {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let owner_addr = Address::new_from_array(seat.trader);
    let market_addr = Address::new_from_array(*market);
    let trading_session = session::validated_session_account(
        &crate::ID,
        &accounts[session_account_index],
        &owner_addr,
        &market_addr,
        seat_index,
        &signer_addr,
        true,
    )?;
    if !trading_session.is_live(now) {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    if trading_session.actions & required_actions == 0 {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    if action_nonce != trading_session.next_expected_nonce {
        return Err(custom(StockStreamError::SessionNonceReplay));
    }
    if trading_session.next_expected_nonce == u64::MAX {
        return Err(custom(StockStreamError::ArithmeticOverflow));
    }
    let opens_new_order = required_actions
        & (SESSION_ACTION_PLACE | SESSION_ACTION_REPLACE | SESSION_ACTION_REDUCE_ONLY_CLOSE)
        != 0;
    if notional < 0
        || notional as u128 > trading_session.max_order_notional as u128
        || (notional as u128).saturating_add(trading_session.consumed_cumulative_notional as u128)
            > trading_session.max_cumulative_notional as u128
        || resulting_exposure > trading_session.max_exposure as u128
        || (opens_new_order && seat.open_order_count >= trading_session.max_open_orders as u32)
    {
        return Err(custom(StockStreamError::RiskViolation));
    }
    Ok(Some(trading_session))
}

/// Commits a session-authorized action's nonce and notional consumption.
/// Must only be called after the complete trading action has already
/// succeeded; on any earlier failure the whole instruction is rejected by
/// the runtime and this is never reached, so the session is left untouched.
pub(crate) fn consume_session_action(
    session_account: &mut AccountView,
    mut trading_session: TradingSession,
    notional: i128,
    action_nonce: u64,
    now: u64,
) -> ProgramResult {
    if notional < 0 || action_nonce != trading_session.next_expected_nonce {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let increment = u64::try_from(notional).map_err(|_| custom(StockStreamError::RiskViolation))?;
    let next_consumed = trading_session
        .consumed_cumulative_notional
        .checked_add(increment)
        .ok_or(custom(StockStreamError::RiskViolation))?;
    if next_consumed > trading_session.max_cumulative_notional {
        return Err(custom(StockStreamError::RiskViolation));
    }
    trading_session.consumed_cumulative_notional = next_consumed;
    trading_session.next_expected_nonce = trading_session
        .next_expected_nonce
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    trading_session.last_action_timestamp = now;
    let bytes = unsafe { session_account.borrow_unchecked_mut() };
    session::write_session(bytes, &trading_session)
}

pub(crate) fn seat_at(data: &[u8], index: usize) -> Result<TraderSeat, ProgramError> {
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
            action_nonce,
        } => cancel_order(
            program_id,
            accounts,
            seat_index as usize,
            order_key,
            action_nonce,
        ),
        StockStreamInstruction::CancelAll {
            seat_index,
            max_cancellations,
            action_nonce,
        } => cancel_all(
            program_id,
            accounts,
            seat_index as usize,
            max_cancellations,
            action_nonce,
        ),
        funding @ StockStreamInstruction::UpdateFunding { .. } => {
            if accounts.len() == crate::v3::V3_SIGNER_ACCOUNT_INDEX + 1
                || accounts.len() == crate::v3::V3_SIGNER_ACCOUNT_INDEX + 2
            {
                crate::v3::update_funding_v3(program_id, accounts, funding)
            } else {
                update_funding(program_id, accounts, funding)
            }
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
            if accounts.len() == 11 {
                consume_oracle_update_v3(program_id, accounts, instruction_data)
            } else {
                consume_oracle_update(program_id, accounts, instruction_data)
            }
        }
        StockStreamInstruction::DelegateMarket { validator } => crate::magicblock::delegate_market(
            program_id,
            accounts,
            Address::new_from_array(validator),
        ),
        StockStreamInstruction::DelegateClusterMember { validator } => {
            crate::magicblock::delegate_cluster_member(
                program_id,
                accounts,
                Address::new_from_array(validator),
            )
        }
        StockStreamInstruction::CreateMarketAccount => {
            crate::registry::create_market_account(program_id, accounts)
        }
        StockStreamInstruction::CreateInstrumentAccount { instrument_id } => {
            crate::registry::create_instrument_account(program_id, accounts, &instrument_id)
        }
        StockStreamInstruction::CreateVaultAccount => {
            crate::registry::create_vault_account(program_id, accounts)
        }
        StockStreamInstruction::CreateScratchAccount { seat_index } => {
            crate::registry::create_scratch_account(program_id, accounts, seat_index)
        }
        StockStreamInstruction::CreateV3Account { kind, index } => {
            crate::registry::create_v3_account(program_id, accounts, kind, index)
        }
        StockStreamInstruction::InitializeV3Market => {
            crate::registry::initialize_v3_market(program_id, accounts)
        }
        StockStreamInstruction::DelegateV3Account {
            kind,
            index,
            validator,
        } => crate::magicblock::delegate_v3_account(
            program_id,
            accounts,
            kind,
            index,
            Address::new_from_array(validator),
        ),
        StockStreamInstruction::CreateV3TraderSeat { seat_index } => {
            crate::v3::create_trader_seat(program_id, accounts, seat_index)
        }
        StockStreamInstruction::CreateV3TradingSession { seat_index } => {
            crate::v3::create_v3_trading_session(program_id, accounts, seat_index)
        }
        StockStreamInstruction::UpdateOracleSnapshotV3 => {
            oracle::update_oracle_snapshot_v3(program_id, accounts, instruction_data)
        }
        StockStreamInstruction::CreateOracleSnapshotV3 => {
            crate::registry::create_oracle_snapshot_v3(program_id, accounts)
        }
        StockStreamInstruction::CloseV3TraderSeat { seat_index } => {
            crate::v3::close_trader_seat(program_id, accounts, seat_index)
        }
        StockStreamInstruction::RequestV3Undelegation => {
            crate::magicblock::request_v3_undelegation(program_id, accounts)
        }
        StockStreamInstruction::RollbackV3Undelegation => {
            crate::magicblock::rollback_v3_undelegation(program_id, accounts)
        }
        StockStreamInstruction::DepositCollateralV3 { seat_index, amount } => {
            crate::v3::deposit_collateral_v3(program_id, accounts, seat_index, amount)
        }
        StockStreamInstruction::WithdrawCollateralV3 { seat_index, amount } => {
            crate::v3::withdraw_collateral_v3(program_id, accounts, seat_index, amount)
        }
        StockStreamInstruction::CommitMarket { sequence } => {
            crate::magicblock::commit_market(program_id, accounts, sequence)
        }
        StockStreamInstruction::CommitAndUndelegate { sequence } => {
            crate::magicblock::commit_and_undelegate_market(program_id, accounts, sequence)
        }
        StockStreamInstruction::AuthorizeTradingSession {
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        } => authorize_trading_session(
            program_id,
            accounts,
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        ),
        StockStreamInstruction::RevokeTradingSession { seat_index } => {
            revoke_trading_session(program_id, accounts, seat_index)
        }
        StockStreamInstruction::UpdateTradingSessionLimits {
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        } => update_trading_session_limits(
            program_id,
            accounts,
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        ),
        StockStreamInstruction::CloseTradingSession { seat_index } => {
            close_trading_session(program_id, accounts, seat_index)
        }
        StockStreamInstruction::ReplaceOrder {
            old_order_key,
            new_order,
        } => replace_order(program_id, accounts, old_order_key, new_order),
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
        StockStreamInstruction::UpdateV3Risk {
            initial_margin_bps,
            maintenance_margin_bps,
            liquidation_fee_bps,
            maker_fee_bps,
            taker_fee_bps,
            maximum_leverage,
            maximum_position,
            maximum_open_interest,
            mark_deviation_bps,
            vault_surplus,
            withdrawal_buffer,
        } => crate::v3::update_v3_risk_config(
            program_id,
            accounts,
            crate::v3::V3RiskConfig {
                initial_margin_bps,
                maintenance_margin_bps,
                liquidation_fee_bps,
                maker_fee_bps,
                taker_fee_bps,
                maximum_leverage,
                maximum_position,
                maximum_open_interest,
                mark_deviation_bps,
                vault_surplus,
                withdrawal_buffer,
            },
        ),
        StockStreamInstruction::ReconcileVaultV3 => {
            crate::v3::reconcile_vault_v3(program_id, accounts)
        }
        StockStreamInstruction::CreateV3VaultAccount => {
            crate::v3::create_v3_vault_account(program_id, accounts)
        }
        StockStreamInstruction::TransitionMarket { mode, action } => {
            transition_market(program_id, accounts, mode, action)
        }
        StockStreamInstruction::TransferToInsuranceFund { amount } => {
            transfer_to_insurance_fund(program_id, accounts, amount)
        }
        StockStreamInstruction::WithdrawProtocolFees { amount } => {
            withdraw_protocol_fees(program_id, accounts, amount)
        }
        StockStreamInstruction::WithdrawInsuranceFunds { amount } => {
            withdraw_insurance_funds(program_id, accounts, amount)
        }
        StockStreamInstruction::RecordBadDebt { seat_index, amount } => {
            record_bad_debt(program_id, accounts, seat_index, amount)
        }
        StockStreamInstruction::ResolveBadDebt { amount } => {
            resolve_bad_debt(program_id, accounts, amount)
        }
        StockStreamInstruction::ReconcileVault => reconcile_vault(program_id, accounts),
        StockStreamInstruction::UpdateExchangeConfig {
            field_mask,
            pause_authority,
            emergency_authority,
            keeper_authority,
            maker_fee_bps,
            taker_fee_bps,
            liquidation_fee_bps,
            default_initial_margin_bps,
            default_maintenance_margin_bps,
            default_maximum_leverage,
            collateral_mint,
            oracle_program,
            insurance_target_balance,
            protocol_status,
            expected_config_sequence,
        } => crate::registry::update_exchange_config(
            program_id,
            accounts,
            crate::registry::UpdateExchangeConfigInput {
                field_mask,
                pause_authority,
                emergency_authority,
                keeper_authority,
                maker_fee_bps,
                taker_fee_bps,
                liquidation_fee_bps,
                default_initial_margin_bps,
                default_maintenance_margin_bps,
                default_maximum_leverage,
                collateral_mint,
                oracle_program,
                insurance_target_balance,
                protocol_status,
                expected_config_sequence,
            },
        ),
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
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.initial_margin_bps = initial;
    header.maintenance_margin_bps = maintenance;
    header.maximum_leverage = leverage;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = current_unix_timestamp()
        .map(|t| t.max(0) as u64)
        .unwrap_or(0);
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::MarketRiskUpdated,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_empty(),
    );
    Ok(())
}

fn transition_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    mode: u8,
    action: crate::instruction::MarketTransitionAction,
) -> ProgramResult {
    if accounts.len() < 2 || mode > MarketMode::Emergency as u8 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != authority {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.mode = mode;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = current_unix_timestamp()
        .map(|t| t.max(0) as u64)
        .unwrap_or(0);
    write_header(data, &header)?;
    // `action` is the original opcode's own identity, preserved through
    // `decode` specifically so this handler can emit the correct distinct
    // event even where two opcodes share the same resulting `mode`
    // (`PAUSE_MARKET`/`CLOSE_MARKET` both mean `Paused`;
    // `RESUME_MARKET`/`RESOLVE_CORPORATE_ACTION` both mean `Open`).
    use crate::instruction::MarketTransitionAction as Action;
    let kind = match action {
        Action::Pause => crate::events::EventKind::MarketPaused,
        Action::Resume => crate::events::EventKind::MarketResumed,
        Action::SetCloseOnly => crate::events::EventKind::MarketCloseOnly,
        Action::EnterCorporateAction => crate::events::EventKind::CorporateActionEntered,
        Action::ResolveCorporateAction => crate::events::EventKind::CorporateActionResolved,
        Action::Close => crate::events::EventKind::MarketClosed,
    };
    crate::events::emit_event(
        kind,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_empty(),
    );
    Ok(())
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

pub const TOKEN_PROGRAM_ID: Address = pinocchio_token::ID;
const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";
/// The SPL Token account data length (Tokenkeg: `Account::LEN = 165`).
pub const TOKEN_ACCOUNT_LEN: usize = 165;

pub(crate) fn derive_vault(market: &Address, program_id: &Address) -> Address {
    Address::find_program_address(&[VAULT_SEED, market.as_ref()], program_id).0
}

pub fn derive_vault_authority(market: &Address, program_id: &Address) -> Address {
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
    {
        let (market_split, rest) = accounts.split_at_mut(1);
        configure_vault_header(
            program_id,
            &mut market_split[0],
            &rest[1],
            &rest[0].address().to_bytes(),
            &rest[1].address().to_bytes(),
        )
    }
}

/// Shared vault-header configuration: validates the mint, sets the custody
/// fields, and emits `VaultInitialized`. Called by both `initialize_vault`
/// (the standalone opcode-9 path) and `registry::create_vault_account` (the
/// opcode-44 combined CPI path).
pub fn configure_vault_header(
    program_id: &Address,
    market: &mut AccountView,
    mint_view: &AccountView,
    authority: &[u8; 32],
    mint_bytes: &[u8; 32],
) -> ProgramResult {
    let decimals = {
        let mint = pinocchio_token::state::Mint::from_account_view(mint_view)
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        if !mint.is_initialized() {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        mint.decimals()
    };
    let market_key = market.address().to_bytes();
    let data = market_data(market, program_id)?;
    let mut header = initialized_header(data)?;
    if header.market_authority != *authority || header.reserved_upgrade[1] != 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.collateral_mint = *mint_bytes;
    header.collateral_token_program = TOKEN_PROGRAM_ID.to_bytes();
    header.reserved_upgrade[0] = decimals;
    header.reserved_upgrade[1] = 1;
    header.set_protocol_fee_balance(0);
    header.set_insurance_fund_balance(0);
    header.set_recognized_bad_debt(0);
    header.set_reconciliation_status(ReconciliationStatus::Reconciled);
    header.set_vault_surplus(0);
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::VaultInitialized,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_empty(),
    );
    Ok(())
}

/// Accounts (exactly 6 -- see the account-ABI hardening pass that removed
/// a 7th, entirely unused slot this handler never read; the seat itself
/// lives inside the market account, so a separate "seat account" was
/// never meaningful here):
/// 0. `[WRITE]`   market
/// 1. `[SIGNER]`  owner (main wallet; must be the claimed seat's trader)
/// 2. `[WRITE]`   source token account (owned by `owner`, holds `mint`)
/// 3. `[WRITE]`   vault (must be this market's canonical vault PDA)
/// 4. `[]`        collateral mint
/// 5. `[]`        token program
fn deposit_collateral(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    amount: u64,
) -> ProgramResult {
    if accounts.len() < 6 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_custody_aliases(&accounts[..6])?;
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    if market_accounts[0].address() == rest[1].address()
        || market_accounts[0].address() == rest[2].address()
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if *rest[2].address() != derive_vault(market_accounts[0].address(), program_id) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let vault_authority = derive_vault_authority(market_accounts[0].address(), program_id);
    let market_key = market_accounts[0].address().to_bytes();
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    custody_config(&header, rest[3].address(), rest[4].address())?;
    validate_custody_tokens(&header, &rest[3], &rest[2], &vault_authority)?;
    let mut seat = seat_at(data, seat_index)?;
    // Only the seat's own owner may deposit for it -- there is no scoped
    // trading-session account in this instruction's account list at all, so
    // a session signer structurally cannot reach this path.
    if seat.trader != rest[0].address().to_bytes() {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    {
        // Scoped so this `Ref` is dropped before the CPI below: the SPL
        // Transfer CPI writer itself rejects any account it touches that is
        // still borrowed (`write_accounts`'s `is_borrowed()` check runs
        // unconditionally, not only on-chain), so holding this borrow open
        // across the call would make every deposit fail with
        // `AccountBorrowFailed` -- a real, pre-existing defect this test
        // suite caught, not a test-only artifact.
        let token_account = pinocchio_token::state::Account::from_account_view(&rest[1])?;
        if token_account.mint() != rest[3].address()
            || token_account.owner() != rest[0].address()
            || token_account.amount() < amount
        {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
    }
    seat.available_collateral = seat
        .available_collateral
        .checked_add(amount as i128)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    // Ledger credit happens before the CPI: every fallible check above (seat
    // ownership, mint/vault/token-program identity, source balance) has
    // already run, and `write_seat` below only executes after the CPI
    // succeeds -- if the CPI fails, `?` aborts the whole instruction and
    // Solana's atomic rollback discards the in-memory `seat` mutation along
    // with everything else, so the credit is never actually observed unless
    // the transfer also succeeded.
    Transfer::<&AccountView>::new(&rest[1], &rest[2], &rest[0], amount)
        .invoke_with_program(rest[4].address())?;
    write_seat(data, seat_index, &seat)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::CollateralDeposited,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(
            seat_index as u16,
            amount,
            seat.available_collateral.max(0) as u64,
        ),
    );
    Ok(())
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
    validate_custody_aliases(&accounts[..7])?;
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
    let mut header = initialized_header(data)?;
    if !header.l1_withdrawals_allowed() {
        return Err(custom(StockStreamError::MagicBlockUndelegationInProgress));
    }
    // A market-wide vault deficit is blocked from the withdrawal path
    // entirely, independent of any individual seat's own health: paying out
    // against a shortfall the vault cannot cover only deepens it for
    // whoever is left. Only `ReconcileVault` (once the shortfall is fixed)
    // or governed recovery clears this.
    if header.withdrawals_blocked_by_reconciliation() {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    custody_config(&header, rest[2].address(), rest[5].address())?;
    validate_custody_tokens(&header, &rest[2], &rest[3], rest[4].address())?;
    let seat = seat_at(data, seat_index)?;
    // Only the seat's own owner may withdraw for it (main-wallet signer
    // check above); no session account is ever passed to this instruction,
    // so a scoped trading session can never expand withdrawal authority.
    // A fresh, valid oracle is required unconditionally, not only when the
    // seat currently has an open position: a position can be opened again
    // the instant after an under-collateralized withdrawal, so basing the
    // requirement on the seat's current position would let a flat seat
    // withdraw against a stale price and then immediately re-lever.
    if seat.trader != trader || seat.occupancy != 1 || header.oracle_valid != 1 {
        return Err(custom(StockStreamError::RiskViolation));
    }
    let seat = risk::prepare_withdrawal(
        &seat,
        amount,
        header.funding_accumulator,
        header.last_verified_oracle_price as i128,
        header.maintenance_margin_bps,
        risk::DEFAULT_WITHDRAWAL_BUFFER,
    )
    .map_err(|_| custom(StockStreamError::RiskViolation))?;
    {
        // Scoped for the same reason as `deposit_collateral`'s source-token
        // check: `destination` (`rest[1]`) is also the CPI's `to` account
        // below, and the SPL Transfer CPI writer rejects any account it
        // touches that is still borrowed when the CPI runs.
        let destination = pinocchio_token::state::Account::from_account_view(&rest[1])
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        if destination.mint() != rest[2].address() || destination.owner() != rest[0].address() {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
    }
    let vault_after = {
        let vault_state = pinocchio_token::state::Account::from_account_view(&rest[3])
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        vault_state
            .amount()
            .checked_sub(amount)
            .ok_or(custom(StockStreamError::CustodyViolation))?
    };
    let seeds = [
        Seed::from(VAULT_AUTHORITY_SEED),
        Seed::from(&market_key),
        Seed::from(&bump),
    ];
    let signer_seeds = [Signer::from(&seeds)];
    // The CPI runs before the seat/header writeback for the same reason as
    // `deposit_collateral`: every fallible check (signer, delegation state,
    // reconciliation state, custody config, mint/vault/destination shape,
    // and the full risk/margin computation) has already completed above, so
    // the only way execution reaches this line is with a transfer that is
    // already known to be valid; if the CPI itself still fails, the runtime
    // discards this instruction's in-memory writes entirely.
    Transfer::<&AccountView>::new(&rest[3], &rest[1], &rest[4], amount)
        .invoke_signed_with_program(&signer_seeds, rest[5].address())?;
    write_seat(data, seat_index, &seat)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::CollateralWithdrawn,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(seat_index as u16, amount, vault_after),
    );
    Ok(())
}

/// Pairwise-distinct check over exactly the accounts the caller passes --
/// no fixed count here. `deposit_collateral` (6 real accounts) and
/// `withdraw_collateral` (7) each pass their own exact slice, so an
/// account substitution attempt (the same address reused for two
/// different roles) is caught regardless of which instruction is calling.
fn validate_custody_aliases(accounts: &[AccountView]) -> ProgramResult {
    for i in 0..accounts.len() {
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
    // `l1_withdrawals_allowed()` is the single source of truth for whether L1
    // custody movement is safe (states `NotDelegated`/`Restored`); this used
    // to duplicate the check against the stale 3-state marker convention
    // (`reserved_upgrade[2] != 0`), which would incorrectly reject deposits
    // and withdrawals for a `Restored` (value 3) market even though
    // `withdraw_collateral` already permits it via the same accessor.
    if !header.l1_withdrawals_allowed() {
        return Err(custom(StockStreamError::MagicBlockUndelegationInProgress));
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

/// Advances and returns the market's shared monotonic event-sequence
/// counter (also used for fill events), for a custody event about to be
/// logged.
fn next_event_sequence(header: &mut MarketStateHeader) -> Result<u64, ProgramError> {
    header.global_event_sequence = header
        .global_event_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    Ok(header.global_event_sequence)
}

/// The protocol clock value events are stamped with (`EventHeader::timestamp`).
/// Never fails: a clock-sysvar error must not prevent an otherwise-valid
/// state transition from committing, so this degrades to `0` rather than
/// aborting the instruction over a logging concern.
pub(crate) fn event_timestamp() -> u64 {
    current_unix_timestamp()
        .map(|t| t.max(0) as u64)
        .unwrap_or(0)
}

/// Sums every seat's `available_collateral` -- the only field that ever
/// actually moves real tokens into or out of the vault (`realized_pnl` and
/// `unrealized_pnl` are health/margin bookkeeping only; see `docs/risk.md`).
/// This is the trader side of the vault-reconciliation invariant. Bounded to
/// exactly `MAX_TRADER_SEATS` (128) reads, same cost class as the existing
/// open-interest scan in `plan_seat_results`.
fn total_trader_collateral(data: &[u8]) -> Result<i128, ProgramError> {
    let mut total: i128 = 0;
    let mut index = 0usize;
    while index < MAX_TRADER_SEATS {
        let seat = seat_at(data, index)?;
        total = total
            .checked_add(seat.available_collateral)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        index += 1;
    }
    Ok(total)
}

/// Requires `accounts[1]` to be the market's `market_authority` and a
/// signer. Used for the governance-only fee/insurance/reconciliation
/// handlers, none of which accept a scoped trading-session account at all
/// (so a session signer can never reach them, regardless of what actions it
/// was granted).
/// Accounts: `[market, market_authority (signer)]`. Internal ledger
/// reassignment only -- both balances are backed by the same vault, so no
/// token CPI is needed or performed.
fn transfer_to_insurance_fund(
    program_id: &Address,
    accounts: &mut [AccountView],
    amount: u64,
) -> ProgramResult {
    if accounts.len() != 2 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    let authority = rest[0].address().to_bytes();
    let market_key = market_accounts[0].address().to_bytes();
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if authority != header.market_authority {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    header.set_protocol_fee_balance(
        header
            .protocol_fee_balance()
            .checked_sub(amount)
            .ok_or(custom(StockStreamError::CustodyViolation))?,
    );
    header.set_insurance_fund_balance(
        header
            .insurance_fund_balance()
            .checked_add(amount)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
    );
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    let insurance_fund_balance = header.insurance_fund_balance();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::InsuranceFundChanged,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(crate::events::NO_SEAT, amount, insurance_fund_balance),
    );
    Ok(())
}

/// Shared implementation for `WithdrawProtocolFees` and
/// `WithdrawInsuranceFunds`: both pay `amount` out of a market-level ledger
/// balance to an external token account via a real vault-authority-signed
/// SPL transfer. Accounts: `[market, authority (signer), vault,
/// vault_authority, destination, mint, token_program]`. The destination must
/// use the market's configured mint and token program -- there is no path to
/// redirect either ledger to an unapproved asset. Emergency authority for
/// the insurance fund, market authority for protocol fees.
fn withdraw_ledger_balance(
    program_id: &Address,
    accounts: &mut [AccountView],
    amount: u64,
    from_insurance: bool,
) -> ProgramResult {
    if accounts.len() != 7 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for i in 0..7 {
        for j in 0..i {
            if accounts[i].address() == accounts[j].address() {
                return Err(custom(StockStreamError::CustodyViolation));
            }
        }
    }
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    let authority = rest[0].address().to_bytes();
    let market_key = market_accounts[0].address().to_bytes();
    if *rest[1].address() != derive_vault(market_accounts[0].address(), program_id)
        || *rest[2].address() != derive_vault_authority(market_accounts[0].address(), program_id)
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let expected_authority = if from_insurance {
        header.emergency_authority
    } else {
        header.market_authority
    };
    if authority != expected_authority {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    custody_config(&header, rest[4].address(), rest[5].address())?;
    validate_custody_tokens(&header, &rest[4], &rest[1], rest[2].address())?;
    let destination_ok = {
        let destination = pinocchio_token::state::Account::from_account_view(&rest[3])
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
        destination.mint() == rest[4].address()
    };
    if !destination_ok {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let current = if from_insurance {
        header.insurance_fund_balance()
    } else {
        header.protocol_fee_balance()
    };
    let updated_balance = current
        .checked_sub(amount)
        .ok_or(custom(StockStreamError::CustodyViolation))?;
    let bump = [Address::find_program_address(&[VAULT_AUTHORITY_SEED, &market_key], program_id).1];
    let seeds = [
        Seed::from(VAULT_AUTHORITY_SEED),
        Seed::from(&market_key),
        Seed::from(&bump),
    ];
    let signer_seeds = [Signer::from(&seeds)];
    Transfer::<&AccountView>::new(&rest[1], &rest[3], &rest[2], amount)
        .invoke_signed_with_program(&signer_seeds, rest[5].address())
        .map_err(|_| custom(StockStreamError::CustodyViolation))?;
    if from_insurance {
        header.set_insurance_fund_balance(updated_balance);
    } else {
        header.set_protocol_fee_balance(updated_balance);
    }
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    let kind = if from_insurance {
        crate::events::EventKind::InsuranceFundChanged
    } else {
        crate::events::EventKind::ProtocolFeesChanged
    };
    crate::events::emit_event(
        kind,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(crate::events::NO_SEAT, amount, updated_balance),
    );
    Ok(())
}

fn withdraw_protocol_fees(
    program_id: &Address,
    accounts: &mut [AccountView],
    amount: u64,
) -> ProgramResult {
    withdraw_ledger_balance(program_id, accounts, amount, false)
}

fn withdraw_insurance_funds(
    program_id: &Address,
    accounts: &mut [AccountView],
    amount: u64,
) -> ProgramResult {
    withdraw_ledger_balance(program_id, accounts, amount, true)
}

/// Accounts: `[market, emergency_authority (signer)]`. Formally recognizes
/// `amount` of a bankrupt seat's negative equity as bad debt the seat itself
/// can never repay (it has no real token claim beyond `available_collateral`
/// >= 0), forgiving that much of the seat's negative `realized_pnl` so its
/// health calculations stop being permanently poisoned by an unrecoverable
/// loss. This never moves tokens or touches `available_collateral`: it is a
/// governance acknowledgement, paired with `ResolveBadDebt` actually paying
/// the recognized shortfall down from the insurance fund.
fn record_bad_debt(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    amount: u64,
) -> ProgramResult {
    if accounts.len() != 2 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    let authority = rest[0].address().to_bytes();
    let market_key = market_accounts[0].address().to_bytes();
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if authority != header.emergency_authority {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    if header.oracle_valid != 1 {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let mut seat = seat_at(data, seat_index as usize)?;
    let equity =
        risk::equity(&seat, header.last_verified_oracle_price as i128).map_err(risk_error)?;
    if equity >= 0 || i128::from(amount) > -equity {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    seat.realized_pnl = seat
        .realized_pnl
        .checked_add(i128::from(amount))
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    header.set_recognized_bad_debt(
        header
            .recognized_bad_debt()
            .checked_add(amount)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
    );
    write_seat(data, seat_index as usize, &seat)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    let recognized_bad_debt = header.recognized_bad_debt();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::BadDebtRecorded,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(seat_index, amount, recognized_bad_debt),
    );
    Ok(())
}

/// Accounts: `[market, emergency_authority (signer)]`. Pays `amount` of
/// recognized bad debt down from the insurance fund ledger -- both balances
/// must actually cover it, so this can never make either go negative or
/// resolve more debt than exists.
fn resolve_bad_debt(
    program_id: &Address,
    accounts: &mut [AccountView],
    amount: u64,
) -> ProgramResult {
    if accounts.len() != 2 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (market_accounts, rest) = accounts.split_at_mut(1);
    signer(&rest[0])?;
    let authority = rest[0].address().to_bytes();
    let market_key = market_accounts[0].address().to_bytes();
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    if authority != header.emergency_authority {
        return Err(custom(StockStreamError::CustodyViolation));
    }
    header.set_recognized_bad_debt(
        header
            .recognized_bad_debt()
            .checked_sub(amount)
            .ok_or(custom(StockStreamError::CustodyViolation))?,
    );
    header.set_insurance_fund_balance(
        header
            .insurance_fund_balance()
            .checked_sub(amount)
            .ok_or(custom(StockStreamError::CustodyViolation))?,
    );
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    let recognized_bad_debt = header.recognized_bad_debt();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::BadDebtResolved,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(crate::events::NO_SEAT, amount, recognized_bad_debt),
    );
    Ok(())
}

/// Accounts: `[market, vault, mint, token_program]`. Permissionless (any
/// keeper may call it): it only ever recomputes and records a status, never
/// moves tokens or seat balances, so there is nothing here for an
/// unprivileged caller to abuse. Compares the vault's actual decoded token
/// balance against `total_trader_collateral + protocol_fee_balance +
/// insurance_fund_balance - recognized_bad_debt` (see `docs/custody.md` for
/// the sign convention: recognized bad debt lowers the amount the vault is
/// expected to hold, because it represents claims governance has already
/// formally written off, not real backed value).
fn reconcile_vault(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for i in 0..4 {
        for j in 0..i {
            if accounts[i].address() == accounts[j].address() {
                return Err(custom(StockStreamError::CustodyViolation));
            }
        }
    }
    let (market_accounts, rest) = accounts.split_at_mut(1);
    let market_key = market_accounts[0].address().to_bytes();
    if *rest[0].address() != derive_vault(market_accounts[0].address(), program_id) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let vault_authority = derive_vault_authority(market_accounts[0].address(), program_id);
    let data = market_data(&mut market_accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    custody_config(&header, rest[1].address(), rest[2].address())?;
    validate_custody_tokens(&header, &rest[1], &rest[0], &vault_authority)?;
    let actual = i128::from(
        pinocchio_token::state::Account::from_account_view(&rest[0])
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?
            .amount(),
    );
    let collateral = total_trader_collateral(data)?;
    let expected = collateral
        .checked_add(i128::from(header.protocol_fee_balance()))
        .and_then(|v| v.checked_add(i128::from(header.insurance_fund_balance())))
        .and_then(|v| v.checked_sub(i128::from(header.recognized_bad_debt())))
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    let previous_status = header.reconciliation_status();
    let (status, surplus, kind) = if actual == expected {
        (
            ReconciliationStatus::Reconciled,
            0u64,
            crate::events::EventKind::VaultReconciled,
        )
    } else if actual > expected {
        (
            ReconciliationStatus::SurplusDetected,
            u64::try_from(actual - expected)
                .map_err(|_| custom(StockStreamError::ArithmeticOverflow))?,
            crate::events::EventKind::VaultSurplusDetected,
        )
    } else {
        let escalated = matches!(previous_status, 2 | 3);
        header.mode = MarketMode::Paused as u8;
        (
            if escalated {
                ReconciliationStatus::RecoveryRequired
            } else {
                ReconciliationStatus::DeficitDetected
            },
            0u64,
            crate::events::EventKind::VaultDeficitDetected,
        )
    };
    header.set_reconciliation_status(status);
    header.set_vault_surplus(surplus);
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    let expected_u64 = u64::try_from(expected).unwrap_or(u64::MAX);
    write_header(data, &header)?;
    crate::events::emit_event(
        kind,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_reconciliation(actual.max(0) as u64, expected_u64, status as u8),
    );
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
/// The native Ed25519 signature-verification program
/// (`Ed25519SigVerify111111111111111111111111111`).
const ED25519_PROGRAM_ID: Address = Address::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);
const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];
const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;
const MAX_PYTH_MESSAGE: usize = 512;

pub(crate) struct VerifiedOracle {
    pub(crate) feed_id: u32,
    pub(crate) channel: u8,
    pub(crate) price: i64,
    pub(crate) exponent: i16,
    pub(crate) confidence: i64,
    /// The signed envelope's own generation timestamp (`PayloadData::timestamp_us`).
    pub(crate) envelope_timestamp_us: u64,
    /// The per-feed `FeedUpdateTimestamp` property: when this specific feed's
    /// price last actually changed, which can lag the envelope timestamp for
    /// a feed that hasn't updated this tick. This -- not the envelope
    /// timestamp -- is the correct value for staleness/monotonic checks.
    pub(crate) feed_update_timestamp_us: u64,
    pub(crate) session: i16,
}

/// Parses the fixed 5-property payload shape the keeper always requests
/// (`price, exponent, confidence, marketSession, feedUpdateTimestamp`, in
/// that order -- see `lib/server/pyth-keeper.ts`'s `PROPERTIES`). Property
/// tags are checked explicitly (`[0, 4, 5, 9, 12]`, the real
/// `PriceFeedProperty` enum discriminants for those five properties) so a
/// differently-shaped payload is rejected rather than misparsed.
pub(crate) fn parse_verified_oracle(message: &[u8]) -> Result<VerifiedOracle, ProgramError> {
    if message.len() < 102
        || u32::from_le_bytes(message[0..4].try_into().unwrap()) != SOLANA_FORMAT_MAGIC
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    // Exact TLV size for the 5 requested properties (header 19 bytes +
    // Price 1+8 + Exponent 1+2 + Confidence 1+8 + MarketSession 1+2 +
    // FeedUpdateTimestamp 1+1+8 = 53), per `PayloadData`/`write_option_price`/
    // `write_option_timestamp` in `pyth_lazer_protocol::payload`. `Option<Price>`
    // properties (Price, Confidence) are a bare i64 with no presence byte
    // (0 encodes `None`); only `FeedUpdateTimestamp` carries an explicit
    // presence flag.
    const EXPECTED_PAYLOAD_LEN: usize = 53;
    let payload_len = u16::from_le_bytes(message[100..102].try_into().unwrap()) as usize;
    if payload_len != EXPECTED_PAYLOAD_LEN || message.len() != 102 + payload_len {
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
        envelope_timestamp_us: u64::from_le_bytes(payload[4..12].try_into().unwrap()),
        channel: payload[12],
        feed_id: u32::from_le_bytes(payload[14..18].try_into().unwrap()),
        price: i64::from_le_bytes(payload[20..28].try_into().unwrap()),
        exponent: i16::from_le_bytes(payload[29..31].try_into().unwrap()),
        confidence: i64::from_le_bytes(payload[32..40].try_into().unwrap()),
        session: i16::from_le_bytes(payload[41..43].try_into().unwrap()),
        feed_update_timestamp_us: u64::from_le_bytes(payload[45..53].try_into().unwrap()),
    })
}

/// Accounts: `[market, payer (signer, writable), pyth_program, storage,
/// treasury (writable), system_program, instructions_sysvar]`.
///
/// Data: `[tag, ed25519_instruction_index: u16 LE, signature_index: u8,
/// signed Solana-format message...]`. The index fields are supplied by the
/// keeper (who controls transaction layout), not assumed -- this handler
/// independently inspects the Instructions sysvar to confirm they name a
/// real, preceding Ed25519-program instruction before ever using them,
/// and the CPI into Pyth's own `verify_message` (which repeats this check
/// authoritatively, plus the actual signature/trusted-signer verification)
/// receives the same caller-supplied values rather than a hardcoded guess.
fn consume_oracle_update(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() != 7 || instruction_data.len() < 107 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let ed25519_instruction_index = u16::from_le_bytes(instruction_data[1..3].try_into().unwrap());
    let signature_index = instruction_data[3];
    let message = &instruction_data[4..];
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

    // Independent Instructions-sysvar inspection: confirm a real Ed25519
    // native-program instruction precedes us at the claimed index before
    // trusting it at all. Pyth's own CPI repeats this (authoritatively,
    // including the actual cryptographic check), but failing fast here with
    // our own error keeps a forged/malformed reference from ever reaching
    // the CPI, and is independently testable without a live Pyth fixture.
    {
        let sysvar = Instructions::try_from(&accounts[6])?;
        let current_index = sysvar.load_current_index();
        if ed25519_instruction_index >= current_index {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
        let ed25519_instruction = sysvar.load_instruction_at(ed25519_instruction_index as usize)?;
        if ed25519_instruction.get_program_id() != &ED25519_PROGRAM_ID {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
        let ed25519_data = ed25519_instruction.get_instruction_data();
        if ed25519_data.is_empty() || signature_index >= ed25519_data[0] {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
    }

    let mut verify_data = [0u8; 527];
    verify_data[..8].copy_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    verify_data[8..12].copy_from_slice(&(message.len() as u32).to_le_bytes());
    verify_data[12..12 + message.len()].copy_from_slice(message);
    verify_data[12 + message.len()..14 + message.len()]
        .copy_from_slice(&ed25519_instruction_index.to_le_bytes());
    verify_data[14 + message.len()] = signature_index;
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
    let now = current_unix_timestamp()?;
    // The feed-specific timestamp is authoritative for staleness; it can
    // never be newer than the envelope that carried it.
    if verified.feed_update_timestamp_us > verified.envelope_timestamp_us {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let timestamp = verified.feed_update_timestamp_us / 1_000_000;
    let market_key = accounts[0].address().to_bytes();
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
    let previous_mode = header.mode;
    header.mode = match verified.session {
        0 | 1 | 2 => MarketMode::Open as u8,
        3 | 4 => MarketMode::CloseOnly as u8,
        _ => return Err(custom(StockStreamError::OracleUnavailable)),
    };
    let sequence = next_event_sequence(&mut header)?;
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::OracleUpdated,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_oracle(
            verified.price,
            verified.exponent,
            verified.confidence,
            verified.session,
        ),
    );
    if header.mode != previous_mode {
        let sequence = next_event_sequence(&mut header)?;
        write_header(data, &header)?;
        crate::events::emit_event(
            crate::events::EventKind::MarketSessionChanged,
            &market_key,
            sequence,
            timestamp,
            &crate::events::payload_oracle(
                verified.price,
                verified.exponent,
                verified.confidence,
                verified.session,
            ),
        );
    }
    Ok(())
}

/// V3 variant of opcode 12. Accounts are `[core, event_shard_0..3, payer,
/// pyth_program, storage, treasury, system_program, instructions_sysvar]`.
/// The signed envelope and verifier CPI are identical to the V2 path, but
/// the result is committed into the bounded core and durable event shards.
fn consume_oracle_update_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() != 11 || instruction_data.len() < 107 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let ed25519_instruction_index = u16::from_le_bytes(instruction_data[1..3].try_into().unwrap());
    let signature_index = instruction_data[3];
    let message = &instruction_data[4..];
    if message.len() > MAX_PYTH_MESSAGE
        || !accounts[5].is_signer()
        || !accounts[5].is_writable()
        || !accounts[6].executable()
        || accounts[6].address() != &PYTH_PROGRAM_ID
        || accounts[7].address() != &PYTH_STORAGE_ID
        || !accounts[7].owned_by(&PYTH_PROGRAM_ID)
        || !accounts[8].is_writable()
        || accounts[9].address() != &SYSTEM_PROGRAM_ID
        || accounts[10].address() != &INSTRUCTIONS_SYSVAR_ID
        || accounts[7].address() == accounts[8].address()
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    {
        let storage = accounts[7].try_borrow()?;
        if storage.len() < 72 || storage[40..72] != accounts[8].address().to_bytes() {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
    }
    {
        let sysvar = Instructions::try_from(&accounts[10])?;
        let current_index = sysvar.load_current_index();
        if ed25519_instruction_index >= current_index {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
        let ed25519_instruction = sysvar.load_instruction_at(ed25519_instruction_index as usize)?;
        if ed25519_instruction.get_program_id() != &ED25519_PROGRAM_ID {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
        let ed25519_data = ed25519_instruction.get_instruction_data();
        if ed25519_data.is_empty() || signature_index >= ed25519_data[0] {
            return Err(custom(StockStreamError::OracleUnavailable));
        }
    }
    let mut verify_data = [0u8; 527];
    verify_data[..8].copy_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    verify_data[8..12].copy_from_slice(&(message.len() as u32).to_le_bytes());
    verify_data[12..12 + message.len()].copy_from_slice(message);
    verify_data[12 + message.len()..14 + message.len()]
        .copy_from_slice(&ed25519_instruction_index.to_le_bytes());
    verify_data[14 + message.len()] = signature_index;
    let metas = [
        InstructionAccount::writable_signer(accounts[5].address()),
        InstructionAccount::readonly(accounts[7].address()),
        InstructionAccount::writable(accounts[8].address()),
        InstructionAccount::readonly(accounts[9].address()),
        InstructionAccount::readonly(accounts[10].address()),
    ];
    let cpi_accounts = [
        &accounts[5],
        &accounts[7],
        &accounts[8],
        &accounts[9],
        &accounts[10],
    ];
    invoke_with_bounds::<5, _>(
        &InstructionView {
            program_id: accounts[6].address(),
            accounts: &metas,
            data: &verify_data[..15 + message.len()],
        },
        &cpi_accounts,
    )?;

    let verified = parse_verified_oracle(message)?;
    let now = current_unix_timestamp()?;
    if verified.feed_update_timestamp_us > verified.envelope_timestamp_us {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let timestamp = verified.feed_update_timestamp_us / 1_000_000;
    let core_data = unsafe { accounts[0].borrow_unchecked() };
    if !accounts[0].owned_by(program_id)
        || !accounts[0].is_writable()
        || core_data.len() != crate::v3::V3_MARKET_CORE_SIZE
        || core_data[0..8] != crate::v3::V3_MARKET_CORE_DISCRIMINATOR
        || core_data[8..10] != crate::v3::V3_LAYOUT_VERSION.to_le_bytes()
        || core_data[10] != 1
        || core_data[crate::v3::V3_CORE_RISK_CONFIG_VERSION_OFFSET]
            != crate::v3::V3_RISK_CONFIG_VERSION
        || core_data
            [crate::v3::V3_CORE_ORACLE_FEED_ID_OFFSET..crate::v3::V3_CORE_ORACLE_FEED_ID_OFFSET + 4]
            != verified.feed_id.to_le_bytes()
        || core_data[crate::v3::V3_CORE_ORACLE_CHANNEL_OFFSET] != verified.channel
        || i32::from(verified.exponent)
            != i32::from_le_bytes(
                core_data[crate::v3::V3_CORE_ORACLE_EXPONENT_OFFSET
                    ..crate::v3::V3_CORE_ORACLE_EXPONENT_OFFSET + 4]
                    .try_into()
                    .map_err(|_| custom(StockStreamError::OracleUnavailable))?,
            )
        || verified.price <= 0
        || verified.confidence < 0
        || verified.confidence as u64 > verified.price.unsigned_abs() / 5
        || now < 0
        || timestamp > now as u64 + 2
        || now as u64 > timestamp.saturating_add(10)
        || timestamp
            <= u64::from_le_bytes(
                core_data[crate::v3::V3_CORE_ORACLE_TIMESTAMP_OFFSET
                    ..crate::v3::V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
                    .try_into()
                    .map_err(|_| custom(StockStreamError::OracleUnavailable))?,
            )
    {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    let previous_mode = core_data[crate::v3::V3_CORE_MODE_OFFSET];
    {
        let core = unsafe { accounts[0].borrow_unchecked_mut() };
        core[crate::v3::V3_CORE_ORACLE_PRICE_OFFSET..crate::v3::V3_CORE_ORACLE_PRICE_OFFSET + 8]
            .copy_from_slice(&verified.price.to_le_bytes());
        core[crate::v3::V3_CORE_ORACLE_TIMESTAMP_OFFSET
            ..crate::v3::V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
            .copy_from_slice(&timestamp.to_le_bytes());
        core[crate::v3::V3_CORE_ORACLE_VALID_OFFSET] = 1;
        core[crate::v3::V3_CORE_ORACLE_SESSION_OFFSET] = u8::try_from(verified.session)
            .map_err(|_| custom(StockStreamError::OracleUnavailable))?;
        core[crate::v3::V3_CORE_ORACLE_CONFIDENCE_OFFSET
            ..crate::v3::V3_CORE_ORACLE_CONFIDENCE_OFFSET + 8]
            .copy_from_slice(&(verified.confidence as u64).to_le_bytes());
        core[crate::v3::V3_CORE_MODE_OFFSET] = match verified.session {
            0 | 1 | 2 => MarketMode::Open as u8,
            3 | 4 => MarketMode::CloseOnly as u8,
            _ => return Err(custom(StockStreamError::OracleUnavailable)),
        };
    }
    let payload = crate::events::payload_oracle(
        verified.price,
        verified.exponent,
        verified.confidence,
        verified.session,
    );
    let (core_accounts, event_accounts) = accounts.split_at_mut(1);
    crate::v3::append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[0..4],
        crate::events::EventKind::OracleUpdated as u16,
        &payload,
        timestamp,
    )?;
    if previous_mode
        != match verified.session {
            0 | 1 | 2 => MarketMode::Open as u8,
            3 | 4 => MarketMode::CloseOnly as u8,
            _ => return Err(custom(StockStreamError::OracleUnavailable)),
        }
    {
        crate::v3::append_event_record(
            program_id,
            &mut core_accounts[0],
            &mut event_accounts[0..4],
            crate::events::EventKind::MarketSessionChanged as u16,
            &payload,
            timestamp,
        )?;
    }
    Ok(())
}

// Real MagicBlock lifecycle CPI handlers (DelegateMarket, CommitMarket,
// CommitAndUndelegate, and the external-undelegate callback) live in
// `crate::magicblock` -- see that module for the account/data contracts,
// which are dictated by the delegation and Magic programs, not by this file.

fn validate_session_policy(
    seat_index: u16,
    expires_at: u64,
    now: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> ProgramResult {
    if seat_index as usize >= MAX_TRADER_SEATS
        || expires_at <= now
        || actions == 0
        || actions & !session::SESSION_ACTION_ALL != 0
        || max_order_notional == 0
        || max_cumulative_notional < max_order_notional
        || maximum_exposure <= 0
        || maximum_open_orders == 0
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    Ok(())
}

/// Accounts: `[market, owner (signer, writable), session (writable, PDA),
/// session_signer, system_program]`. Creates and initializes the canonical
/// `TradingSession` PDA via a real System Program CPI signed with its own
/// derived seeds (a PDA cannot sign a top-level client transaction, so the
/// account cannot be pre-created by the client the way a keypair account
/// could be).
#[allow(clippy::too_many_arguments)]
fn authorize_trading_session(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> ProgramResult {
    if (accounts.len() == crate::v3::V3_EXECUTION_BUNDLE_LEN + 4
        || accounts.len() == crate::v3::V3_EXECUTION_BUNDLE_LEN + 5)
        && accounts[0].data_len() == crate::v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8]
            == crate::v3::V3_MARKET_CORE_DISCRIMINATOR
    {
        return crate::v3::authorize_trading_session_v3(
            program_id,
            accounts,
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        );
    }
    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    if !accounts[1].is_writable() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let owner = *accounts[1].address();
    let market_addr = *accounts[0].address();
    let session_signer = *accounts[3].address();
    if *accounts[4].address() != pinocchio_system::ID {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    // The session signer must be a distinct key from every authority that
    // could otherwise bypass session scoping.
    if session_signer == owner || session_signer == market_addr {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let data = market_data(&mut accounts[0], program_id)?;
    let header = initialized_header(data)?;
    validate_session_policy(
        seat_index,
        expires_at,
        header.last_verified_oracle_timestamp,
        actions,
        max_order_notional,
        max_cumulative_notional,
        maximum_exposure,
        maximum_open_orders,
    )?;
    let seat = seat_at(data, seat_index as usize)?;
    if seat.occupancy != 1 || seat.trader != owner.to_bytes() {
        return Err(custom(StockStreamError::InvalidSeat));
    }

    let (expected_pda, bump) = Address::find_program_address(
        &[
            session::TRADING_SESSION_SEED,
            owner.as_ref(),
            market_addr.as_ref(),
            &seat_index.to_le_bytes(),
            session_signer.as_ref(),
        ],
        program_id,
    );
    if expected_pda != *accounts[2].address() || !accounts[2].is_writable() {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    if accounts[2].owned_by(program_id) {
        // Already initialized (or previously revoked and never closed):
        // reject rather than silently reusing the slot. `CloseTradingSession`
        // must reclaim it first.
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    if accounts[2].lamports() != 0 {
        // A system-owned, pre-funded PDA cannot be passed to CreateAccount.
        // Reject it explicitly instead of relying on the system program's
        // opaque failure and leaving callers with an ambiguous session state.
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let bump_slice = [bump];
    let seat_index_bytes = seat_index.to_le_bytes();
    let seeds = [
        pinocchio::cpi::Seed::from(session::TRADING_SESSION_SEED),
        pinocchio::cpi::Seed::from(owner.as_ref()),
        pinocchio::cpi::Seed::from(market_addr.as_ref()),
        pinocchio::cpi::Seed::from(&seat_index_bytes),
        pinocchio::cpi::Seed::from(session_signer.as_ref()),
        pinocchio::cpi::Seed::from(&bump_slice),
    ];
    let session_signer_seeds = pinocchio::cpi::Signer::from(&seeds);
    let rent = current_rent()?;
    pinocchio_system::instructions::CreateAccount {
        from: &accounts[1],
        to: &accounts[2],
        lamports: rent.try_minimum_balance(session::TRADING_SESSION_SIZE)?,
        space: session::TRADING_SESSION_SIZE as u64,
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(&session_signer_seeds))?;

    let mut session_state = TradingSession::empty();
    session_state.initialized = 1;
    session_state.owner = owner.to_bytes();
    // The session signer stays client-held; the program only stores its
    // public key and policy, never a signing secret.
    session_state.session_signer = session_signer.to_bytes();
    session_state.target_program = program_id.to_bytes();
    session_state.market = market_addr.to_bytes();
    session_state.trader_seat_index = seat_index;
    session_state.created_at = header.last_verified_oracle_timestamp;
    session_state.expires_at = expires_at;
    session_state.actions = actions;
    session_state.max_order_notional = max_order_notional;
    session_state.max_cumulative_notional = max_cumulative_notional;
    session_state.max_exposure = maximum_exposure;
    session_state.max_open_orders = maximum_open_orders;
    let session_bytes = unsafe { accounts[2].borrow_unchecked_mut() };
    session::write_session(session_bytes, &session_state)?;
    // Re-acquire the market borrow: the original `data`/`header` above were
    // only ever needed for the validation/seat lookup at the top of this
    // function, and holding that borrow open across the CreateAccount CPI
    // and every `accounts[1]`/`accounts[2]` access in between would
    // conflict with them under the borrow checker (this is the same
    // split-then-reacquire pattern used throughout this file whenever a
    // handler needs the market header both before and after touching other
    // accounts).
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TradingSessionAuthorized,
        &market_addr.to_bytes(),
        sequence,
        timestamp,
        &crate::events::payload_session(seat_index, &session_signer.to_bytes(), 0),
    );
    Ok(())
}

/// Accounts: `[market, owner (signer), session (writable, PDA), session_signer]`.
fn revoke_trading_session(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    if accounts.len() == crate::v3::V3_EXECUTION_BUNDLE_LEN + 3
        && accounts[0].data_len() == crate::v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8]
            == crate::v3::V3_MARKET_CORE_DISCRIMINATOR
    {
        return crate::v3::revoke_trading_session_v3(program_id, accounts, seat_index);
    }
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let owner = *accounts[1].address();
    let market_addr = *accounts[0].address();
    let session_signer = *accounts[3].address();
    let mut session_state = session::validated_session_account(
        program_id,
        &accounts[2],
        &owner,
        &market_addr,
        seat_index,
        &session_signer,
        true,
    )?;
    // Idempotent: revoking an already-revoked session is a no-op success,
    // not an error -- there is no meaningful "unrevoke" to protect against.
    session_state.revoked = 1;
    let bytes = unsafe { accounts[2].borrow_unchecked_mut() };
    session::write_session(bytes, &session_state)?;
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TradingSessionRevoked,
        &market_addr.to_bytes(),
        sequence,
        timestamp,
        &crate::events::payload_session(seat_index, &session_signer.to_bytes(), 0),
    );
    Ok(())
}

/// Accounts: `[market, owner (signer), session (writable, PDA), session_signer]`.
///
/// Never callable by the session signer itself (only `accounts[1]`, which
/// must equal `session.owner`, may authorize this) -- a session can never
/// expand its own authority. Limits may only be tightened or loosened by the
/// owner; a revoked session can never be updated back to life, only replaced
/// via a fresh `AuthorizeTradingSession` after `CloseTradingSession`.
#[allow(clippy::too_many_arguments)]
fn update_trading_session_limits(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> ProgramResult {
    if accounts.len() == crate::v3::V3_EXECUTION_BUNDLE_LEN + 3
        && accounts[0].data_len() == crate::v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8]
            == crate::v3::V3_MARKET_CORE_DISCRIMINATOR
    {
        return crate::v3::update_trading_session_v3(
            program_id,
            accounts,
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        );
    }
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let owner = *accounts[1].address();
    let market_addr = *accounts[0].address();
    let session_signer = *accounts[3].address();
    let data_now = {
        let data = market_data(&mut accounts[0], program_id)?;
        initialized_header(data)?.last_verified_oracle_timestamp
    };
    let mut session_state = session::validated_session_account(
        program_id,
        &accounts[2],
        &owner,
        &market_addr,
        seat_index,
        &session_signer,
        true,
    )?;
    if session_state.revoked == 1 {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    validate_session_policy(
        seat_index,
        expires_at,
        data_now,
        actions,
        max_order_notional,
        max_cumulative_notional,
        maximum_exposure,
        maximum_open_orders,
    )?;
    // A tightened cumulative limit must not retroactively invalidate
    // notional the session has already legitimately consumed.
    if max_cumulative_notional < session_state.consumed_cumulative_notional {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    session_state.expires_at = expires_at;
    session_state.actions = actions;
    session_state.max_order_notional = max_order_notional;
    session_state.max_cumulative_notional = max_cumulative_notional;
    session_state.max_exposure = maximum_exposure;
    session_state.max_open_orders = maximum_open_orders;
    session_state.session_generation = session_state
        .session_generation
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    let bytes = unsafe { accounts[2].borrow_unchecked_mut() };
    session::write_session(bytes, &session_state)?;
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    // Reuses the `payload_session` nonce slot to carry the session's own
    // `session_generation` counter -- there is no nonce being consumed by
    // a limits update, but the generation number serves the same
    // "which version of this session is this" purpose for an indexer.
    crate::events::emit_event(
        crate::events::EventKind::TradingSessionLimitsUpdated,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_session(
            seat_index,
            &session_signer.to_bytes(),
            session_state.session_generation.into(),
        ),
    );
    Ok(())
}

/// Accounts: `[market, owner (signer, writable), session (writable, PDA), session_signer]`.
/// Reclaims the session PDA's rent to the owner. Always safe: a session
/// holds no funds or open state of its own (orders/collateral live on the
/// trader seat), so closing one only removes future authorization.
fn close_trading_session(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    if accounts.len() == crate::v3::V3_EXECUTION_BUNDLE_LEN + 3
        && accounts[0].data_len() == crate::v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8]
            == crate::v3::V3_MARKET_CORE_DISCRIMINATOR
    {
        return crate::v3::close_trading_session_v3(program_id, accounts, seat_index);
    }
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    if !accounts[1].is_writable() {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let owner = *accounts[1].address();
    let market_addr = *accounts[0].address();
    let session_signer = *accounts[3].address();
    let data_now = {
        let data = market_data(&mut accounts[0], program_id)?;
        initialized_header(data)?.last_verified_oracle_timestamp
    };
    let session_state = session::validated_session_account(
        program_id,
        &accounts[2],
        &owner,
        &market_addr,
        seat_index,
        &session_signer,
        true,
    )?;
    if session_state.revoked == 0 && session_state.expires_at > data_now {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let refund = accounts[2].lamports();
    accounts[2].set_lamports(0);
    let owner_lamports = accounts[1].lamports();
    accounts[1].set_lamports(owner_lamports.saturating_add(refund));
    let bytes = unsafe { accounts[2].borrow_unchecked_mut() };
    bytes.fill(0);
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TradingSessionClosed,
        &market_addr.to_bytes(),
        sequence,
        timestamp,
        &crate::events::payload_session(seat_index, &session_signer.to_bytes(), 0),
    );
    Ok(())
}

fn create_seat(program_id: &Address, accounts: &mut [AccountView], index: usize) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
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
    write_seat(data, index, &seat)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TraderSeatCreated,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat(index as u16),
    );
    Ok(())
}

fn close_seat(program_id: &Address, accounts: &mut [AccountView], index: usize) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let seat = seat_at(data, index)?;
    if seat.trader != trader {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    if !seat.can_close() {
        return Err(custom(StockStreamError::SeatNotEmpty));
    }
    write_seat(data, index, &TraderSeat::empty())?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TraderSeatClosed,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_seat(index as u16),
    );
    Ok(())
}

#[inline(never)]
fn is_v3_execution_bundle(program_id: &Address, accounts: &[AccountView]) -> bool {
    accounts.len() >= crate::v3::V3_EXECUTION_BUNDLE_LEN
        && crate::v3::validate_execution_bundle(
            program_id,
            &accounts[..crate::v3::V3_EXECUTION_BUNDLE_LEN],
            true,
        )
        .is_ok()
}

#[inline(never)]
fn place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
) -> ProgramResult {
    if is_v3_execution_bundle(program_id, accounts) {
        return crate::v3::place_order_v3(program_id, accounts, order);
    }
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
    let session_notional = if order.price_or_offset > 0 {
        (order.quantity as i128)
            .checked_mul(order.price_or_offset as i128)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
    } else {
        0
    };
    let (trading_session, seat_owner) = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, order.seat_index as usize)?;
        let signed_qty = if order.side == Side::Bid as u8 {
            order.quantity as i128
        } else {
            -(order.quantity as i128)
        };
        let resulting_exposure = snapshot_seat
            .base_position
            .checked_add(signed_qty)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
            .unsigned_abs();
        let required_actions = if order.flags & 4 != 0 {
            SESSION_ACTION_PLACE | SESSION_ACTION_REDUCE_ONLY_CLOSE
        } else {
            SESSION_ACTION_PLACE
        };
        let trading_session = authorize_trading_actor(
            accounts,
            &market_address,
            &snapshot_seat,
            order.seat_index,
            3,
            required_actions,
            session_notional,
            resulting_exposure,
            order.action_nonce,
            snapshot_header.last_verified_oracle_timestamp,
        )?;
        (trading_session, snapshot_seat.trader)
    };
    let session_authorized = trading_session.is_some();
    let (order_notional, now) = place_order_core(
        program_id,
        accounts,
        order,
        trader,
        seat_owner,
        session_authorized,
    )?;
    if let Some(trading_session) = trading_session {
        consume_session_action(
            &mut accounts[3],
            trading_session,
            order_notional,
            order.action_nonce,
            now,
        )?;
        emit_session_action_consumed(
            program_id,
            accounts,
            order.seat_index,
            &trading_session.session_signer,
            order.action_nonce,
        )?;
    }
    Ok(())
}

/// The full matching/settlement pipeline for a new order: validates market
/// state and the order shape, plans the match, applies it to the book and
/// settlement scratch, and writes the updated market header. Does not touch
/// session state -- callers (`place_order`, `replace_order`) authorize
/// first and consume the session nonce/notional only after this succeeds.
/// Returns the order's notional and the oracle timestamp used, so the
/// caller can consume the session action without recomputing either.
fn place_order_core(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
    trader: [u8; 32],
    seat_owner: [u8; 32],
    session_authorized: bool,
) -> Result<(i128, u64), ProgramError> {
    let market_address = accounts[0].address().to_bytes();
    let (market_accounts, remaining_accounts) = accounts.split_at_mut(2);
    let (scratch_accounts, _session_accounts) = remaining_accounts.split_at_mut(1);
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
    if order.side > 1 || order.tree > 1 || order.flags & !31 != 0 {
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
    // Bits 3-4 of the same flags byte (5 of its 8 bits were unused): the
    // explicit self-trade-prevention mode, packed in rather than growing
    // the instruction's wire size.
    let self_trade_behavior = crate::book::SelfTradeBehavior::from_u8((order.flags >> 3) & 0b11)
        .ok_or(custom(StockStreamError::InvalidInstruction))?;
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
    let taker_funding_payment =
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
        self_trade_behavior,
    };
    // `input.leaf()` is pure (derives the price/time key from side/price/
    // sequence without touching book state), so it is safe to call here,
    // before matching, purely to recover the same key a resting order would
    // carry -- even one that fully matches and never rests. The event
    // itself is not emitted until after settlement succeeds (see below):
    // reserving/persisting its sequence this early, before the order's
    // fate (including a possible post-only rejection) is known, would mean
    // writing the account before success is certain, breaking this
    // function's no-partial-writes-on-failure invariant that a post-only
    // rejection or plan-staleness error depends on.
    let order_key = input.leaf().map_err(book_error)?.key;
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
    let total_fee = plan_seat_results(data, &mut scratch, input, header, &taker)?;
    validate_settlement_plan(data, &scratch, input, header, &taker_before)?;
    if scratch.plan().post_only_rejected {
        scratch.abort_to(&scratch_before);
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if scratch.plan().self_trade_aborted {
        // `SelfTradeBehavior::AbortTransaction`: exactly like
        // `post_only_rejected` above, the *plan* is valid -- it is the
        // order that is refused. Nothing is applied, so the trader's own
        // resting order survives and no crossed book is left behind.
        scratch.abort_to(&scratch_before);
        return Err(custom(StockStreamError::SelfTradeAborted));
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
    apply_scratch_results(data, &scratch, &market_address)?;
    let scratch_result = scratch.read_header();
    let mut updated = header;
    updated.global_order_sequence = scratch_result.final_order_sequence;
    updated.global_event_sequence = scratch_result.final_event_sequence;
    updated.current_open_interest = scratch_result.open_interest_after;
    // Emitted only now that settlement has actually succeeded (a post-only
    // rejection or a stale-plan error above already returned before this
    // point, leaving the account untouched). Its sequence is reserved
    // *after* any fills this same order produced (`final_event_sequence`
    // already advanced past them), so an indexer must not assume
    // `OrderPlaced` always sorts ahead of its own same-instruction fills --
    // only that both share one transaction and a monotonic sequence space.
    let order_sequence = next_event_sequence(&mut updated)?;
    let order_timestamp = event_timestamp();
    crate::events::emit_event(
        crate::events::EventKind::OrderPlaced,
        &market_address,
        order_sequence,
        order_timestamp,
        &crate::events::payload_order(
            order.seat_index,
            order_key,
            order.side,
            current_price,
            order.quantity,
        ),
    );
    // The taker seat's own per-instruction funding settlement (maker-side
    // settlements, inside `plan_seat_results`, are not covered -- wiring
    // them would mean reserving event sequences from inside the matching
    // loop, which already produces one collision bug this session; left as
    // a deliberate, documented scope decision rather than risking another).
    if taker_funding_payment != 0 {
        let sequence = next_event_sequence(&mut updated)?;
        crate::events::emit_event(
            crate::events::EventKind::FundingSettled,
            &market_address,
            sequence,
            event_timestamp(),
            &crate::events::payload_funding(
                order.seat_index,
                header.funding_accumulator,
                taker_funding_payment,
            ),
        );
    }
    // Resting orders the matching engine swept off the book while walking
    // past the incoming order's price (a stale owner-occupancy slot, or one
    // whose `expires_at` had already passed) -- see `plan_limit_arenas_into`.
    // The plan only tracks *counts*, not each removed order's own seat/key,
    // so these are emitted as a single market-level record per instruction
    // rather than one event per removed order.
    let invalid_removed = scratch.plan().invalid_removed;
    if invalid_removed > 0 {
        let sequence = next_event_sequence(&mut updated)?;
        crate::events::emit_event(
            crate::events::EventKind::InvalidOrderRemoved,
            &market_address,
            sequence,
            event_timestamp(),
            &crate::events::payload_seat_amount(crate::events::NO_SEAT, invalid_removed as u64, 0),
        );
    }
    let expired_removed = scratch.plan().expired_removed;
    if expired_removed > 0 {
        let sequence = next_event_sequence(&mut updated)?;
        crate::events::emit_event(
            crate::events::EventKind::OrderExpired,
            &market_address,
            sequence,
            event_timestamp(),
            &crate::events::payload_seat_amount(crate::events::NO_SEAT, expired_removed as u64, 0),
        );
    }
    // Self-trade prevention actually acted on this instruction
    // (`CancelProvide` removed the trader's own resting order, or
    // `DecrementTake` reduced this order's remaining quantity without
    // touching the maker). `AbortTransaction` never reaches this point --
    // it already returned above with nothing applied.
    let self_cancelled = scratch.plan().self_cancelled;
    if self_cancelled > 0 {
        let sequence = next_event_sequence(&mut updated)?;
        crate::events::emit_event(
            crate::events::EventKind::SelfTradePrevented,
            &market_address,
            sequence,
            event_timestamp(),
            &crate::events::payload_seat_amount(order.seat_index, self_cancelled as u64, 0),
        );
    }
    // Maker+taker fees charged this instruction (already deducted from the
    // relevant seats' `realized_pnl` by `apply_fill`) are credited to the
    // protocol fee ledger here, atomically with the rest of the settlement.
    if total_fee > 0 {
        let fee_u64 =
            u64::try_from(total_fee).map_err(|_| custom(StockStreamError::ArithmeticOverflow))?;
        updated.set_protocol_fee_balance(
            updated
                .protocol_fee_balance()
                .checked_add(fee_u64)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
        );
        let sequence = next_event_sequence(&mut updated)?;
        let timestamp = event_timestamp();
        let protocol_fee_balance = updated.protocol_fee_balance();
        write_header(data, &updated)?;
        crate::events::emit_event(
            crate::events::EventKind::ProtocolFeesChanged,
            &market_address,
            sequence,
            timestamp,
            &crate::events::payload_seat_amount(
                crate::events::NO_SEAT,
                fee_u64,
                protocol_fee_balance,
            ),
        );
    } else {
        write_header(data, &updated)?;
    }
    let mut scratch_header = scratch.read_header();
    scratch_header.plan_nonce = nonce;
    scratch_header.status = ScratchStatus::Ready as u8;
    scratch.write_header(&scratch_header);
    scratch.clear();
    Ok((order_notional, header.last_verified_oracle_timestamp))
}

/// Atomically cancels `old_order_key` and places `new_order` in its place.
/// The new order always receives a fresh sequence number (from
/// `place_order_core`'s own `header.global_order_sequence + 1`), so a
/// replacement always loses book time priority -- a price/quantity-changing
/// replacement is, by design, not distinguishable on-chain from an
/// independent cancel-then-place. Because this program has no explicit
/// rollback path, atomicity comes entirely from Solana's own instruction
/// semantics: if `place_order_core` fails after the cancel already ran, this
/// function's `?` propagates the error out of `dispatch`, so the runtime
/// reverts every account write made during the instruction -- the cancelled
/// order, its released reserve, and the session's nonce/notional are all
/// left exactly as they were before this instruction ran.
///
/// Session-notional policy: a replacement is charged the new order's full
/// notional, exactly like an independent `PlaceOrder`. The old order's
/// notional is not credited back, consistent with this program's
/// cumulative-activity (not outstanding-notional) session accounting: see
/// `authorize_trading_actor`.
fn replace_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    old_order_key: u128,
    order: PlaceOrderData,
) -> ProgramResult {
    if is_v3_execution_bundle(program_id, accounts) {
        return crate::v3::replace_order_v3(program_id, accounts, old_order_key, order);
    }
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
    let session_notional = if order.price_or_offset > 0 {
        (order.quantity as i128)
            .checked_mul(order.price_or_offset as i128)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
    } else {
        0
    };
    let (trading_session, seat_owner) = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, order.seat_index as usize)?;
        let signed_qty = if order.side == Side::Bid as u8 {
            order.quantity as i128
        } else {
            -(order.quantity as i128)
        };
        let resulting_exposure = snapshot_seat
            .base_position
            .checked_add(signed_qty)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
            .unsigned_abs();
        let trading_session = authorize_trading_actor(
            accounts,
            &market_address,
            &snapshot_seat,
            order.seat_index,
            3,
            SESSION_ACTION_REPLACE,
            session_notional,
            resulting_exposure,
            order.action_nonce,
            snapshot_header.last_verified_oracle_timestamp,
        )?;
        (trading_session, snapshot_seat.trader)
    };
    let session_authorized = trading_session.is_some();
    {
        let data = market_data(&mut accounts[0], program_id)?;
        let market_header = initialized_header(data)?;
        if market_header.mode != MarketMode::Open as u8 {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
        if seat_at(data, order.seat_index as usize)?.trader != trader && !session_authorized {
            return Err(custom(StockStreamError::InvalidSeat));
        }
        cancel_order_core(data, order.seat_index as usize, old_order_key)?;
    }
    let (order_notional, now) = place_order_core(
        program_id,
        accounts,
        order,
        trader,
        seat_owner,
        session_authorized,
    )?;
    // Carries the *old* order's key alongside the new order's shape -- the
    // new order's own key is recoverable from the `OrderPlaced` event
    // `place_order_core` already emitted for it a moment ago.
    {
        let market_key = accounts[0].address().to_bytes();
        let data = market_data(&mut accounts[0], program_id)?;
        let mut header = initialized_header(data)?;
        let sequence = next_event_sequence(&mut header)?;
        let timestamp = event_timestamp();
        write_header(data, &header)?;
        crate::events::emit_event(
            crate::events::EventKind::OrderReplaced,
            &market_key,
            sequence,
            timestamp,
            &crate::events::payload_order(
                order.seat_index,
                old_order_key,
                order.side,
                order.price_or_offset,
                order.quantity,
            ),
        );
    }
    if let Some(trading_session) = trading_session {
        consume_session_action(
            &mut accounts[3],
            trading_session,
            order_notional,
            order.action_nonce,
            now,
        )?;
        emit_session_action_consumed(
            program_id,
            accounts,
            order.seat_index,
            &trading_session.session_signer,
            order.action_nonce,
        )?;
    }
    Ok(())
}

/// Computes every seat, margin, event and market result before the arena is
/// touched. `TraderSeat` values live in scratch slots rather than an SBF stack
/// array; a slot is allocated once per participating maker plus the taker.
/// Returns the total maker+taker fee charged across every fill in this
/// instruction, so the caller can credit it to the protocol fee ledger --
/// `apply_fill` already deducts it from each seat's `realized_pnl`, but
/// nothing previously credited it anywhere, an accounting gap this closes.
#[inline(never)]
fn plan_seat_results(
    data: &[u8],
    scratch: &mut SettlementScratchView,
    input: OrderInput,
    header: MarketStateHeader,
    taker_initial: &TraderSeat,
) -> Result<i128, ProgramError> {
    let mut taker = *taker_initial;
    scratch.write_seat_result(0, &taker)?;
    scratch.set_seat_result_index(0, input.owner as u16)?;

    let mut total_fee: i128 = 0;
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
        let maker_fee = risk::apply_fill(
            &mut maker,
            -signed,
            fill.price as i128,
            header.maker_fee_bps,
        )
        .map_err(risk_error)?;
        let taker_fee =
            risk::apply_fill(&mut taker, signed, fill.price as i128, header.taker_fee_bps)
                .map_err(risk_error)?;
        total_fee = total_fee
            .checked_add(maker_fee)
            .and_then(|v| v.checked_add(taker_fee))
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
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
            // `header.global_event_sequence` is the *last used* sequence
            // (every other event kind assigns via `next_event_sequence`'s
            // increment-then-assign convention), so the first fill in this
            // instruction must take `+ 1`, not reuse the current value --
            // otherwise it collides with whatever event last advanced this
            // same counter (e.g. a trailing `OrderPlaced` from a prior
            // instruction, or a custody event on this market).
            sequence: header
                .global_event_sequence
                .checked_add(1)
                .and_then(|v| v.checked_add(fill_index as u64))
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
    Ok(total_fee)
}

fn apply_scratch_results(
    data: &mut [u8],
    scratch: &SettlementScratchView,
    market_address: &[u8; 32],
) -> ProgramResult {
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
    // Whether the *incoming* order (the one this instruction placed) ends
    // this instruction with no quantity left unfilled -- used to classify
    // every fill this instruction produced as `OrderFilled` or
    // `OrderPartiallyFilled`. This is a per-instruction, not a per-fill,
    // classification: a fill that fully closes one maker's resting order
    // can still leave the taker's larger incoming order partially filled,
    // and this program does not track maker-side fill completion
    // separately, so every fill in one instruction shares the incoming
    // order's own completion state.
    let taker_order_fully_filled = scratch.plan().remaining == 0;
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
        // Reuses the ring buffer's own `value.sequence` as this binary
        // event's header sequence: the program-log record and the
        // event-ring record refer to the exact same logical fill, so they
        // must share one sequence number rather than each consuming a
        // fresh one.
        crate::events::emit_event(
            if taker_order_fully_filled {
                crate::events::EventKind::OrderFilled
            } else {
                crate::events::EventKind::OrderPartiallyFilled
            },
            market_address,
            value.sequence,
            value.timestamp,
            &crate::events::payload_fill(
                value.maker_seat,
                value.taker_seat,
                value.price,
                value.quantity,
                value.sequence,
            ),
        );
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
            let side_index = if leaf.side == Side::Bid as u8 { 0 } else { 1 };
            removed_by_side[side_index] = removed_by_side[side_index]
                .checked_add(1)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
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

/// Removes one order owned by `seat_index` and releases its reserved
/// margin. Shared by `cancel_order` and `replace_order`; on any error the
/// caller's `?` aborts the whole instruction, so a failed removal here
/// never partially mutates the book.
fn cancel_order_core(data: &mut [u8], seat_index: usize, order_key: u128) -> ProgramResult {
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
    let leaf = removed.map_err(|_| custom(StockStreamError::InvalidInstruction))?;
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
    write_seat(data, seat_index, &seat)
}

fn cancel_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    order_key: u128,
    action_nonce: u64,
) -> ProgramResult {
    if is_v3_execution_bundle(program_id, accounts) {
        return crate::v3::cancel_order_v3(
            program_id,
            accounts,
            seat_index as u16,
            order_key,
            action_nonce,
        );
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let market_address = accounts[0].address().to_bytes();
    let trading_session = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, seat_index)?;
        let resulting_exposure = snapshot_seat.base_position.unsigned_abs();
        authorize_trading_actor(
            accounts,
            &market_address,
            &snapshot_seat,
            seat_index as u16,
            2,
            SESSION_ACTION_CANCEL,
            0,
            resulting_exposure,
            action_nonce,
            snapshot_header.last_verified_oracle_timestamp,
        )?
    };
    let session_authorized = trading_session.is_some();
    let data = market_data(&mut accounts[0], program_id)?;
    let now = initialized_header(data)?.last_verified_oracle_timestamp;
    if seat_at(data, seat_index)?.trader != trader && !session_authorized {
        return Err(custom(StockStreamError::InvalidSeat));
    }
    cancel_order_core(data, seat_index, order_key)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    // `cancel_order_core` does not currently surface the removed leaf's
    // side/price/quantity back to its caller, so this event carries the
    // seat and order key only; `side=0xff` marks "not available" rather
    // than a real bid/ask value.
    crate::events::emit_event(
        crate::events::EventKind::OrderCancelled,
        &market_address,
        sequence,
        timestamp,
        &crate::events::payload_order(seat_index as u16, order_key, 0xff, 0, 0),
    );
    if let Some(trading_session) = trading_session {
        consume_session_action(&mut accounts[2], trading_session, 0, action_nonce, now)?;
        emit_session_action_consumed(
            program_id,
            accounts,
            seat_index as u16,
            &trading_session.session_signer,
            action_nonce,
        )?;
    }
    Ok(())
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
    let market_key = accounts[0].address().to_bytes();
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
    if timestamp < header.last_funding_timestamp {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    // The program computes the mark itself from the live book plus the
    // verified oracle (see `mark.rs`): the submitted accumulator increment
    // may never exceed what that mark justifies, so a malicious keeper
    // cannot select an arbitrary funding rate. The increment is bounded by
    // the per-elapsed-second absolute cap AND the mark/index basis
    // (whichever is smaller), symmetric in sign so negative bases bound
    // negative funding equally.
    {
        // Read-only arena borrows for the mark computation (the arenas live
        // inside the same market account; the header write below is the
        // only mutation this instruction makes). NEVER copy an Arena by
        // value here: a 90,640-byte stack object overflows the SBPF stack
        // frame immediately (verified by the runtime harness).
        let bids: &Arena =
            unsafe { &*(data.as_ptr().add(crate::state::BID_ARENA_OFFSET) as *const Arena) };
        let asks: &Arena =
            unsafe { &*(data.as_ptr().add(crate::state::ASK_ARENA_OFFSET) as *const Arena) };
        let mark =
            crate::mark::executable_mark(&bids, &asks, &header, header.last_verified_oracle_price)?;
        let index = header.last_verified_oracle_price;
        let basis_bps = (mark.price as i128 - index as i128)
            .checked_mul(10_000)
            .and_then(|value| value.checked_div(index as i128))
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        let elapsed = timestamp.saturating_sub(header.last_funding_timestamp);
        // Absolute per-second funding-rate cap, independent of the basis.
        const FUNDING_CAP_BPS_PER_SEC: i128 = 1;
        let cap = FUNDING_CAP_BPS_PER_SEC
            .checked_mul(elapsed as i128)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?
            .min(basis_bps.abs());
        let requested_increment = (accumulator as i128)
            .checked_sub(header.funding_accumulator as i128)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        if requested_increment.abs() > cap {
            return Err(custom(StockStreamError::InvalidInstruction));
        }
    }
    if accumulator < header.funding_accumulator {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    header.funding_accumulator = accumulator;
    header.last_funding_timestamp = timestamp;
    let sequence = next_event_sequence(&mut header)?;
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::FundingAccumulatorUpdated,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_funding(crate::events::NO_SEAT, accumulator, 0),
    );
    Ok(())
}

fn liquidate(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: usize,
    max_quantity: u64,
) -> ProgramResult {
    if accounts.len() >= crate::v3::V3_EXECUTION_BUNDLE_LEN + 1 {
        return crate::v3::liquidate_v3(program_id, accounts, seat_index as u16, max_quantity);
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let authority = accounts[1].address().to_bytes();
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
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
    let started_sequence = next_event_sequence(&mut header)?;
    crate::events::emit_event(
        crate::events::EventKind::LiquidationStarted,
        &market_key,
        started_sequence,
        event_timestamp(),
        &crate::events::payload_liquidation(
            seat_index as u16,
            quantity.unsigned_abs() as u64,
            header.last_verified_oracle_price,
        ),
    );
    let liquidation_fee = risk::apply_fill(
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
    write_seat(data, seat_index, &seat)?;
    let position_sequence = next_event_sequence(&mut header)?;
    crate::events::emit_event(
        crate::events::EventKind::PositionChanged,
        &market_key,
        position_sequence,
        event_timestamp(),
        &crate::events::payload_position(
            seat_index as u16,
            seat.base_position,
            seat.quote_entry_value,
        ),
    );
    let margin_sequence = next_event_sequence(&mut header)?;
    crate::events::emit_event(
        crate::events::EventKind::MarginChanged,
        &market_key,
        margin_sequence,
        event_timestamp(),
        &crate::events::payload_seat_amount(
            seat_index as u16,
            seat.reserved_margin.max(0) as u64,
            0,
        ),
    );
    let liquidation_sequence = next_event_sequence(&mut header)?;
    let liquidation_timestamp = event_timestamp();
    if liquidation_fee > 0 {
        let fee_u64 = u64::try_from(liquidation_fee)
            .map_err(|_| custom(StockStreamError::ArithmeticOverflow))?;
        header.set_protocol_fee_balance(
            header
                .protocol_fee_balance()
                .checked_add(fee_u64)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
        );
        let fee_sequence = next_event_sequence(&mut header)?;
        let protocol_fee_balance = header.protocol_fee_balance();
        write_header(data, &header)?;
        crate::events::emit_event(
            crate::events::EventKind::PositionLiquidated,
            &market_key,
            liquidation_sequence,
            liquidation_timestamp,
            &crate::events::payload_liquidation(
                seat_index as u16,
                quantity.unsigned_abs() as u64,
                header.last_verified_oracle_price,
            ),
        );
        crate::events::emit_event(
            crate::events::EventKind::ProtocolFeesChanged,
            &market_key,
            fee_sequence,
            event_timestamp(),
            &crate::events::payload_seat_amount(seat_index as u16, fee_u64, protocol_fee_balance),
        );
    } else {
        write_header(data, &header)?;
        crate::events::emit_event(
            crate::events::EventKind::PositionLiquidated,
            &market_key,
            liquidation_sequence,
            liquidation_timestamp,
            &crate::events::payload_liquidation(
                seat_index as u16,
                quantity.unsigned_abs() as u64,
                header.last_verified_oracle_price,
            ),
        );
    }
    Ok(())
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
    action_nonce: u64,
) -> ProgramResult {
    if is_v3_execution_bundle(program_id, accounts) {
        return crate::v3::cancel_all_v3(
            program_id,
            accounts,
            seat_index as u16,
            max,
            action_nonce,
        );
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let market_address = accounts[0].address().to_bytes();
    let trading_session = {
        let snapshot = unsafe { accounts[0].borrow_unchecked() };
        let snapshot_header = initialized_header(snapshot)?;
        let snapshot_seat = seat_at(snapshot, seat_index)?;
        let resulting_exposure = snapshot_seat.base_position.unsigned_abs();
        authorize_trading_actor(
            accounts,
            &market_address,
            &snapshot_seat,
            seat_index as u16,
            2,
            SESSION_ACTION_CANCEL_ALL,
            0,
            resulting_exposure,
            action_nonce,
            snapshot_header.last_verified_oracle_timestamp,
        )?
    };
    let session_authorized = trading_session.is_some();
    let data = market_data(&mut accounts[0], program_id)?;
    let now = initialized_header(data)?.last_verified_oracle_timestamp;
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
    let mut header = initialized_header(data)?;
    let released = risk::initial_margin(
        total.reserved_notional.min(i128::MAX as u128) as i128,
        header.initial_margin_bps,
    )
    .map_err(risk_error)?;
    seat.reserved_margin = seat.reserved_margin.saturating_sub(released);
    write_seat(data, seat_index, &seat)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::CancelAllProgress,
        &market_address,
        sequence,
        timestamp,
        &crate::events::payload_seat_amount(seat_index as u16, total.count as u64, 0),
    );
    if let Some(trading_session) = trading_session {
        consume_session_action(&mut accounts[2], trading_session, 0, action_nonce, now)?;
        emit_session_action_consumed(
            program_id,
            accounts,
            seat_index as u16,
            &trading_session.session_signer,
            action_nonce,
        )?;
    }
    Ok(())
}

/// Emitted after a scoped-session action (`PlaceOrder`, `ReplaceOrder`,
/// `CancelOrder`, `CancelAll`) has already fully succeeded and consumed
/// this session's nonce/notional -- always the *last* thing an instruction
/// does, after the primary event for that action, so its sequence sorts
/// after whatever action it is reporting on.
fn emit_session_action_consumed(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    session_signer: &[u8; 32],
    nonce: u64,
) -> ProgramResult {
    let market_key = accounts[0].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    let sequence = next_event_sequence(&mut header)?;
    let timestamp = event_timestamp();
    write_header(data, &header)?;
    crate::events::emit_event(
        crate::events::EventKind::TradingSessionActionConsumed,
        &market_key,
        sequence,
        timestamp,
        &crate::events::payload_session(seat_index, session_signer, nonce),
    );
    Ok(())
}
