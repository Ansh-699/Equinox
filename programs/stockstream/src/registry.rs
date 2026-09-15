use core::mem::size_of;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{error::StockStreamError, handlers};

pub const EXCHANGE_DISCRIMINATOR: [u8; 8] = *b"STKEXC01";
pub const INSTRUMENT_DISCRIMINATOR: [u8; 8] = *b"STKINS01";
pub const INSTRUMENT_SIZE: usize = 128;
pub const EXCHANGE_SIZE: usize = 128;
pub const INSTRUMENT_SEED: &[u8] = b"instrument";
pub const PERP_MARKET_SEED: &[u8] = b"perp-market";

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct ExchangeConfig {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub authority: [u8; 32],
    pub instrument_count: u32,
    pub reserved: [u8; 81],
}
const _: [(); EXCHANGE_SIZE] = [(); size_of::<ExchangeConfig>()];

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
    data[8..10].copy_from_slice(&1u16.to_le_bytes());
    data[10] = 1;
    data[11..43].copy_from_slice(&authority);
    Ok(())
}

pub fn register_instrument(
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
    Ok(())
}

pub fn update_instrument(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
    exponent: i32,
) -> ProgramResult {
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
    data[75..79].copy_from_slice(&exponent.to_le_bytes());
    Ok(())
}

pub fn suspend_instrument(
    program_id: &Address,
    accounts: &mut [AccountView],
    id: [u8; 32],
) -> ProgramResult {
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
    data[79] = 1;
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
    if *accounts[1].address() != derive_perp_market(program_id, accounts[0].address()) {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let instrument = unsafe { accounts[0].borrow_unchecked() };
    if instrument.len() != INSTRUMENT_SIZE
        || instrument[0..8] != INSTRUMENT_DISCRIMINATOR
        || instrument[10] == 0
        || instrument[11..43] != id
    {
        return Err(custom(StockStreamError::InvalidInstruction));
    }
    let authority = accounts[2].address().clone();
    handlers::initialize_market_account(program_id, &mut accounts[1], &authority, &id)
}
