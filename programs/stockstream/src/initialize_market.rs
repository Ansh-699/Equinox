use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::StockStreamError;

pub struct AccountAccess<'a> {
    pub is_signer: bool,
    pub is_writable: bool,
    pub owner: &'a Address,
}

pub fn validate_initialize_market(
    program_id: &Address,
    accounts: &[AccountAccess<'_>],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let market = &accounts[0];
    if !market.is_writable {
        return Err(StockStreamError::MarketNotWritable.into());
    }
    if market.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if !accounts[1].is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    Ok(())
}

pub fn process(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let account_access = [
        AccountAccess {
            is_signer: accounts[0].is_signer(),
            is_writable: accounts[0].is_writable(),
            owner: accounts[0].owner(),
        },
        AccountAccess {
            is_signer: accounts[1].is_signer(),
            is_writable: accounts[1].is_writable(),
            owner: accounts[1].owner(),
        },
    ];

    validate_initialize_market(program_id, &account_access)
}
