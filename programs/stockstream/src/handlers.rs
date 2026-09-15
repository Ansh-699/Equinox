use core::{
    mem::{align_of, size_of, MaybeUninit},
    ptr,
};

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    book::{
        match_limit_arenas, plan_limit_arenas, Arena, MatchLimits, OrderInput, PlanAction,
        PlannedMatch, Side, TimeInForce, TreeKind,
    },
    error::StockStreamError,
    instruction::{PlaceOrderData, StockStreamInstruction},
    risk,
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

fn signer(account: &AccountView) -> ProgramResult {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
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
    }
}

fn initialize_market(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let market_key = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
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

fn place_order(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    signer(&accounts[1])?;
    let trader = accounts[1].address().to_bytes();
    let data = market_data(&mut accounts[0], program_id)?;
    let header = initialized_header(data)?;
    if header.mode != MarketMode::Open as u8 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if seat_at(data, order.seat_index as usize)?.trader != trader || order.quantity == 0 {
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
    let planned = unsafe {
        let bids = &*(data.as_ptr().add(crate::state::BID_ARENA_OFFSET) as *const Arena);
        let asks = &*(data.as_ptr().add(crate::state::ASK_ARENA_OFFSET) as *const Arena);
        plan_limit_arenas(
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
        )
        .map_err(book_error)?
    };
    validate_settlement_plan(data, &planned, input, header.initial_margin_bps)?;
    if planned.post_only_rejected {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let result = unsafe {
        let bids = &mut *(data.as_mut_ptr().add(crate::state::BID_ARENA_OFFSET) as *mut Arena);
        let asks = &mut *(data.as_mut_ptr().add(crate::state::ASK_ARENA_OFFSET) as *mut Arena);
        match_limit_arenas(
            bids,
            asks,
            input,
            Some(header.last_verified_oracle_price),
            now,
            MatchLimits {
                max_fills: crate::book::MAX_MATCH_FILLS as u8,
                max_invalid_removals: 8,
                max_expired_removals: 8,
            },
        )
        .map_err(book_error)?
    };
    if result.post_only_rejected {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let mut fill_index = 0usize;
    while fill_index < result.fill_count as usize {
        let fill = result.fills[fill_index];
        let maker_index = fill.maker as usize;
        let mut maker = seat_at(data, maker_index)?;
        risk::settle_funding(&mut maker, header.funding_accumulator).map_err(risk_error)?;
        let signed = if side == Side::Bid {
            fill.quantity as i128
        } else {
            -(fill.quantity as i128)
        };
        let maker_signed = -signed;
        risk::apply_fill(
            &mut maker,
            maker_signed,
            fill.price as i128,
            header.maker_fee_bps,
        )
        .map_err(risk_error)?;
        risk::apply_fill(&mut taker, signed, fill.price as i128, header.taker_fee_bps)
            .map_err(risk_error)?;
        let released = risk::initial_margin(
            risk::notional(fill.quantity as i128, fill.price as i128).map_err(risk_error)?,
            header.initial_margin_bps,
        )
        .map_err(risk_error)?;
        maker.reserved_margin = maker.reserved_margin.saturating_sub(released);
        if fill.maker_remaining == 0 {
            maker.open_order_count = maker.open_order_count.saturating_sub(1);
        }
        if side == Side::Bid {
            maker.open_ask_exposure = maker
                .open_ask_exposure
                .saturating_sub(fill.quantity as i128);
        } else {
            maker.open_bid_exposure = maker
                .open_bid_exposure
                .saturating_sub(fill.quantity as i128);
        }
        write_seat(data, maker_index, &maker)?;
        append_fill(
            data,
            header.global_event_sequence + fill_index as u64,
            fill.maker,
            fill.taker,
            fill.price,
            fill.quantity,
            fill.maker_client_order_id,
            now,
        )?;
        fill_index += 1;
    }
    if result.remaining > 0 && tif == TimeInForce::GoodTilCancelled {
        let remaining_required = risk::initial_margin(
            risk::notional(result.remaining as i128, current_price as i128).map_err(risk_error)?,
            header.initial_margin_bps,
        )
        .map_err(risk_error)?;
        taker.reserved_margin = taker
            .reserved_margin
            .checked_add(remaining_required)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        taker.open_order_count = taker
            .open_order_count
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        if side == Side::Bid {
            taker.open_bid_exposure = taker
                .open_bid_exposure
                .checked_add(result.remaining as i128)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        } else {
            taker.open_ask_exposure = taker
                .open_ask_exposure
                .checked_add(result.remaining as i128)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        }
    }
    write_seat(data, order.seat_index as usize, &taker)?;
    let mut updated = header;
    updated.global_order_sequence = sequence;
    updated.global_event_sequence = header
        .global_event_sequence
        .checked_add(result.fill_count as u64)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    updated.current_open_interest = recompute_open_interest(data)?;
    write_header(data, &updated)
}

fn validate_settlement_plan(
    data: &[u8],
    plan: &PlannedMatch,
    order: OrderInput,
    initial_margin_bps: u16,
) -> ProgramResult {
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
            initial_margin_bps,
        )
        .map_err(risk_error)?;
    }
    Ok(())
}

fn recompute_open_interest(data: &[u8]) -> Result<i128, ProgramError> {
    let mut total = 0i128;
    let mut index = 0usize;
    while index < MAX_TRADER_SEATS {
        let seat = seat_at(data, index)?;
        total = total
            .checked_add(
                seat.base_position
                    .checked_abs()
                    .ok_or(custom(StockStreamError::ArithmeticOverflow))?,
            )
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        index += 1;
    }
    Ok(total / 2)
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
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    if seat_at(data, seat_index)?.trader != trader {
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

fn append_fill(
    data: &mut [u8],
    sequence: u64,
    maker: u32,
    taker: u32,
    price: i64,
    quantity: u64,
    client_order_id: u64,
    timestamp: u64,
) -> ProgramResult {
    let event = FillEvent {
        sequence,
        maker_seat: maker,
        taker_seat: taker,
        price,
        quantity,
        maker_client_order_id: client_order_id,
        timestamp,
        reserved: [0; 16],
    };
    let offset = FILL_EVENT_OFFSET + (sequence as usize % FILL_EVENT_CAPACITY) * FILL_EVENT_SIZE;
    if offset + FILL_EVENT_SIZE > data.len() {
        return Err(custom(StockStreamError::InvalidMarketLayout));
    }
    unsafe {
        ptr::copy_nonoverlapping(
            &event as *const FillEvent as *const u8,
            data.as_mut_ptr().add(offset),
            FILL_EVENT_SIZE,
        );
    }
    Ok(())
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
    let data = market_data(&mut accounts[0], program_id)?;
    initialized_header(data)?;
    if seat_at(data, seat_index)?.trader != trader {
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
