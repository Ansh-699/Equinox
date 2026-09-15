use core::{
    mem::{align_of, size_of, MaybeUninit},
    ptr,
};

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    book::Arena,
    error::StockStreamError,
    instruction::{PlaceOrderData, StockStreamInstruction},
    state::{
        MarketStateHeader, TraderSeat, MARKET_ACCOUNT_SIZE, MARKET_DISCRIMINATOR,
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
        StockStreamInstruction::UpdateFunding { .. } => {
            Err(custom(StockStreamError::UnsupportedInProduction))
        }
        StockStreamInstruction::Liquidate { .. } => {
            Err(custom(StockStreamError::OracleUnavailable))
        }
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
    if seat_at(data, order.seat_index as usize)?.trader != trader || order.quantity == 0 {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    if header.oracle_valid == 0 {
        return Err(custom(StockStreamError::OracleUnavailable));
    }
    Err(custom(StockStreamError::UnsupportedInProduction))
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
    let bid = arena_mut(data, crate::state::BID_ARENA_OFFSET)?;
    if bid
        .remove_owned(crate::book::TreeKind::Fixed, order_key, seat_index as u32)
        .is_ok()
    {
        return Ok(());
    }
    let ask = arena_mut(data, crate::state::ASK_ARENA_OFFSET)?;
    if ask
        .remove_owned(crate::book::TreeKind::Fixed, order_key, seat_index as u32)
        .is_ok()
    {
        return Ok(());
    }
    Err(custom(StockStreamError::InvalidInstruction))
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
        .cancel_owner(seat_index as u32, max)
        .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
    if first < max {
        let ask = arena_mut(data, crate::state::ASK_ARENA_OFFSET)?;
        let _ = ask
            .cancel_owner(seat_index as u32, max - first)
            .map_err(|_| custom(StockStreamError::InvalidInstruction))?;
    }
    Ok(())
}
