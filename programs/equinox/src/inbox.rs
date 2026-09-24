//! Deposit inbox: collateral deposits that work while a V3 market is
//! delegated to the MagicBlock rollup.
//!
//! `deposit_to_inbox_v3` (L1) moves tokens into the market vault and adds the
//! amount to a per-(market, trader) receipt PDA. It never writes the core or
//! any shard, so it runs whether or not the bundle is delegated.
//! `claim_inbox_deposit_v3` runs wherever the bundle lives (the rollup reads
//! the receipt as a cloned L1 account) and credits `receipt.total - credited`
//! to the trader's seat, where `credited` is a monotonic counter kept in the
//! seat. Each deposited token is therefore credited exactly once, and vault
//! liability rises only when the seat is credited: until then the vault simply
//! holds a surplus, which reconciliation records and never pays out.

use pinocchio::{
    account::AccountView, address::Address, error::ProgramError, ProgramResult,
};
use pinocchio_token::{instructions::Transfer, state::Account as TokenAccount};

use crate::error::EquinoxError;
use crate::state::DelegationStatus;
use crate::v3;

pub const RECEIPT_SEED: &[u8] = b"deposit-receipt-v3";
pub const RECEIPT_DISCRIMINATOR: [u8; 8] = *b"STKDR003";
pub const RECEIPT_SIZE: usize = 84;
const RECEIPT_CORE: usize = 12;
const RECEIPT_TRADER: usize = 44;
const RECEIPT_TOTAL: usize = 76;
/// `TraderSeat.reserved[0..8]`: total already credited from the inbox.
const SEAT_CREDITED: core::ops::Range<usize> = 0..8;

pub fn derive_receipt(program_id: &Address, core: &Address, trader: &Address) -> (Address, u8) {
    Address::find_program_address(&[RECEIPT_SEED, core.as_ref(), trader.as_ref()], program_id)
}

/// The core's static identity: a live (mode 1) V3 market. Read-only here, so a
/// delegated core (owned by the delegation program on L1) is accepted.
fn check_core(program_id: &Address, core: &AccountView) -> ProgramResult {
    if !(core.owned_by(program_id) || core.owned_by(&crate::magicblock::DELEGATION_PROGRAM_ID)) {
        return Err(EquinoxError::InvalidMarketLayout.into());
    }
    let bytes = unsafe { core.borrow_unchecked() };
    if bytes.len() != v3::V3_MARKET_CORE_SIZE
        || bytes[0..8] != v3::V3_MARKET_CORE_DISCRIMINATOR
        || bytes[8..10] != v3::V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != 1
        || bytes[v3::V3_CORE_MODE_OFFSET] != 1
    {
        return Err(EquinoxError::InvalidMarketLayout.into());
    }
    Ok(())
}

/// L1: `[core (ro), receipt (w), trader (signer, w), source (w), vault (w),
/// mint (ro), token_program, system_program]`, data `[60, amount: u64]`.
pub fn deposit_to_inbox_v3(program_id: &Address, accounts: &mut [AccountView], amount: u64) -> ProgramResult {
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if amount == 0 {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    if !accounts[2].is_signer() || !accounts[2].is_writable() || !accounts[1].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_core(program_id, &accounts[0])?;
    let core_key = *accounts[0].address();
    let trader_key = *accounts[2].address();
    let mint = Address::new_from_array(
        unsafe { accounts[0].borrow_unchecked() }[76..108].try_into().map_err(|_| EquinoxError::InvalidMarketLayout)?,
    );
    if *accounts[4].address() != crate::handlers::derive_vault(&core_key, program_id)
        || *accounts[5].address() != mint
        || *accounts[6].address() != pinocchio_token::ID
        || *accounts[7].address() != pinocchio_system::ID
    {
        return Err(EquinoxError::CustodyViolation.into());
    }
    {
        let source = TokenAccount::from_account_view(&accounts[3]).map_err(|_| EquinoxError::CustodyViolation)?;
        let vault = TokenAccount::from_account_view(&accounts[4]).map_err(|_| EquinoxError::CustodyViolation)?;
        if *source.owner() != trader_key
            || *source.mint() != mint
            || source.amount() < amount
            || *vault.owner() != crate::handlers::derive_vault_authority(&core_key, program_id)
            || *vault.mint() != mint
        {
            return Err(EquinoxError::CustodyViolation.into());
        }
    }

    let (expected, bump) = derive_receipt(program_id, &core_key, &trader_key);
    if *accounts[1].address() != expected {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    if accounts[1].data_len() == 0 {
        let bump_slice = [bump];
        let seeds = [
            pinocchio::cpi::Seed::from(RECEIPT_SEED),
            pinocchio::cpi::Seed::from(core_key.as_ref()),
            pinocchio::cpi::Seed::from(trader_key.as_ref()),
            pinocchio::cpi::Seed::from(&bump_slice),
        ];
        pinocchio_system::instructions::CreateAccount {
            from: &accounts[2],
            to: &accounts[1],
            lamports: Rent::get()?.try_minimum_balance(RECEIPT_SIZE)?,
            space: RECEIPT_SIZE as u64,
            owner: program_id,
        }
        .invoke_signed(core::slice::from_ref(&pinocchio::cpi::Signer::from(&seeds)))?;
        let receipt = unsafe { accounts[1].borrow_unchecked_mut() };
        receipt[0..8].copy_from_slice(&RECEIPT_DISCRIMINATOR);
        receipt[8..10].copy_from_slice(&v3::V3_LAYOUT_VERSION.to_le_bytes());
        receipt[10] = bump;
        receipt[RECEIPT_CORE..RECEIPT_CORE + 32].copy_from_slice(core_key.as_ref());
        receipt[RECEIPT_TRADER..RECEIPT_TRADER + 32].copy_from_slice(trader_key.as_ref());
    } else {
        validate_receipt(program_id, &accounts[1], &core_key)?;
    }

    Transfer::<&AccountView>::new(&accounts[3], &accounts[4], &accounts[2], amount)
        .invoke_with_program(accounts[6].address())?;
    let receipt = unsafe { accounts[1].borrow_unchecked_mut() };
    let total = u64::from_le_bytes(receipt[RECEIPT_TOTAL..RECEIPT_TOTAL + 8].try_into().unwrap())
        .checked_add(amount)
        .ok_or(EquinoxError::ArithmeticOverflow)?;
    receipt[RECEIPT_TOTAL..RECEIPT_TOTAL + 8].copy_from_slice(&total.to_le_bytes());
    Ok(())
}

/// A program-owned receipt for `core`, at its canonical PDA. Returns `(trader, total)`.
fn validate_receipt(program_id: &Address, receipt: &AccountView, core: &Address) -> Result<(Address, u64), ProgramError> {
    if !receipt.owned_by(program_id) {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    let bytes = unsafe { receipt.borrow_unchecked() };
    if bytes.len() != RECEIPT_SIZE
        || bytes[0..8] != RECEIPT_DISCRIMINATOR
        || bytes[8..10] != v3::V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[RECEIPT_CORE..RECEIPT_CORE + 32] != *core.as_ref()
    {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    let trader = Address::new_from_array(bytes[RECEIPT_TRADER..RECEIPT_TRADER + 32].try_into().unwrap());
    if derive_receipt(program_id, core, &trader).0 != *receipt.address() {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    Ok((trader, u64::from_le_bytes(bytes[RECEIPT_TOTAL..RECEIPT_TOTAL + 8].try_into().unwrap())))
}

/// Wherever the bundle lives: `[core (w), seat_shard (w), event_shard × 4 (w),
/// receipt (ro)]`, data `[61, seat_index: u16]`. Permissionless: the credit
/// can only ever go to the receipt owner's own seat.
pub fn claim_inbox_deposit_v3(program_id: &Address, accounts: &mut [AccountView], seat_index: u16) -> ProgramResult {
    if accounts.len() != 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let core_key = v3::validate_event_core(program_id, &accounts[0])?;
    if unsafe { accounts[0].borrow_unchecked() }[v3::V3_CORE_DELEGATION_STATUS_OFFSET] == DelegationStatus::Undelegating as u8 {
        return Err(EquinoxError::CustodyViolation.into());
    }
    let (shard, slot) = ((seat_index as usize) / v3::V3_SEATS_PER_SHARD, (seat_index as usize) % v3::V3_SEATS_PER_SHARD);
    if shard >= v3::V3_SEAT_SHARDS {
        return Err(EquinoxError::InvalidSeat.into());
    }
    v3::validate_seat_shard(program_id, &accounts[1], &core_key, shard as u8)?;
    for index in 0..v3::V3_EVENT_SHARDS {
        v3::validate_event_shard(program_id, &accounts[2 + index], &core_key, index as u8)?;
    }
    let (trader, total) = validate_receipt(program_id, &accounts[6], &core_key)?;

    let mut seat = v3::read_shard_seat(unsafe { accounts[1].borrow_unchecked() }, slot)?;
    if seat.occupancy != 1 || seat.trader != trader.to_bytes() {
        return Err(EquinoxError::InvalidSeat.into());
    }
    let credited = u64::from_le_bytes(seat.reserved[SEAT_CREDITED].try_into().unwrap());
    let amount = total.checked_sub(credited).filter(|delta| *delta > 0).ok_or(EquinoxError::InvalidInstruction)?;
    seat.available_collateral = seat
        .available_collateral
        .checked_add(i128::from(amount))
        .ok_or(EquinoxError::ArithmeticOverflow)?;
    seat.reserved[SEAT_CREDITED].copy_from_slice(&total.to_le_bytes());
    write_credit(program_id, accounts, slot, seat_index, amount, &seat)
}

fn write_credit(
    program_id: &Address,
    accounts: &mut [AccountView],
    slot: usize,
    seat_index: u16,
    amount: u64,
    seat: &crate::state::TraderSeat,
) -> ProgramResult {
    let liability = v3::core_i128(unsafe { accounts[0].borrow_unchecked() }, v3::V3_CORE_VAULT_LIABILITY_OFFSET)?
        .checked_add(i128::from(amount))
        .ok_or(EquinoxError::ArithmeticOverflow)?;
    v3::write_shard_seat(unsafe { accounts[1].borrow_unchecked_mut() }, slot, seat)?;
    let mut core_copy = accounts[0].clone();
    v3::set_core_i128(unsafe { core_copy.borrow_unchecked_mut() }, v3::V3_CORE_VAULT_LIABILITY_OFFSET, liability)?;
    let mut events = [accounts[2].clone(), accounts[3].clone(), accounts[4].clone(), accounts[5].clone()];
    let mut payload = [0u8; crate::events::EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..10].copy_from_slice(&amount.to_le_bytes());
    payload[10..18].copy_from_slice(&(seat.available_collateral.max(0) as u64).to_le_bytes());
    v3::append_event_record(
        program_id,
        &mut core_copy,
        &mut events,
        crate::events::EventKind::CollateralDeposited as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

pub const PAYOUT_SEED: &[u8] = b"withdraw-receipt-v3";
pub const PAYOUT_DISCRIMINATOR: [u8; 8] = *b"STKWR003";
/// `TraderSeat.reserved[8..16]`: total ever requested for withdrawal in the rollup.
const SEAT_REQUESTED: core::ops::Range<usize> = 8..16;

pub fn derive_payout_receipt(program_id: &Address, core: &Address, trader: &Address) -> (Address, u8) {
    Address::find_program_address(&[PAYOUT_SEED, core.as_ref(), trader.as_ref()], program_id)
}

/// L1 payout of rollup withdrawal requests: `[core (ro), seat_shard (ro),
/// trader (signer, w), destination (w), vault (w), vault_authority, mint,
/// token_program, payout_receipt (w), system_program]`, data
/// `[63, seat_index:u16]`. Reads the seat as last committed to L1 (owned by
/// the delegation program while delegated) and pays `requested - paid`, where
/// `paid` lives in a per-(market, trader) receipt, so each request pays once.
pub fn claim_withdrawal_v3(program_id: &Address, accounts: &mut [AccountView], seat_index: u16) -> ProgramResult {
    use pinocchio::cpi::{Seed, Signer};
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    if accounts.len() != 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[2].is_signer() || !accounts[2].is_writable() || !accounts[8].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    check_core(program_id, &accounts[0])?;
    let core_key = *accounts[0].address();
    let trader_key = *accounts[2].address();
    let (shard, slot) = ((seat_index as usize) / v3::V3_SEATS_PER_SHARD, (seat_index as usize) % v3::V3_SEATS_PER_SHARD);
    if shard >= v3::V3_SEAT_SHARDS {
        return Err(EquinoxError::InvalidSeat.into());
    }
    let shard_account = &accounts[1];
    if !(shard_account.owned_by(program_id) || shard_account.owned_by(&crate::magicblock::DELEGATION_PROGRAM_ID))
        || *shard_account.address() != v3::derive_seat_shard_v3(program_id, &core_key, shard as u8)
    {
        return Err(EquinoxError::InvalidSeat.into());
    }
    let requested = {
        let bytes = unsafe { shard_account.borrow_unchecked() };
        if bytes.len() < 44 || bytes[0..8] != v3::V3_SEAT_SHARD_DISCRIMINATOR || bytes[12..44] != *core_key.as_ref() {
            return Err(EquinoxError::InvalidSeat.into());
        }
        let seat = v3::read_shard_seat(bytes, slot)?;
        if seat.occupancy != 1 || seat.trader != trader_key.to_bytes() {
            return Err(EquinoxError::InvalidSeat.into());
        }
        u64::from_le_bytes(seat.reserved[SEAT_REQUESTED].try_into().unwrap())
    };

    let mint = Address::new_from_array(
        unsafe { accounts[0].borrow_unchecked() }[76..108].try_into().map_err(|_| EquinoxError::InvalidMarketLayout)?,
    );
    let (vault_authority, authority_bump) =
        Address::find_program_address(&[b"vault-authority", core_key.as_ref()], program_id);
    if *accounts[4].address() != crate::handlers::derive_vault(&core_key, program_id)
        || *accounts[5].address() != vault_authority
        || *accounts[6].address() != mint
        || *accounts[7].address() != pinocchio_token::ID
        || *accounts[9].address() != pinocchio_system::ID
    {
        return Err(EquinoxError::CustodyViolation.into());
    }

    let (expected, bump) = derive_payout_receipt(program_id, &core_key, &trader_key);
    if *accounts[8].address() != expected {
        return Err(EquinoxError::InvalidInstruction.into());
    }
    if accounts[8].data_len() == 0 {
        let bump_slice = [bump];
        let seeds = [Seed::from(PAYOUT_SEED), Seed::from(core_key.as_ref()), Seed::from(trader_key.as_ref()), Seed::from(&bump_slice)];
        pinocchio_system::instructions::CreateAccount {
            from: &accounts[2],
            to: &accounts[8],
            lamports: Rent::get()?.try_minimum_balance(RECEIPT_SIZE)?,
            space: RECEIPT_SIZE as u64,
            owner: program_id,
        }
        .invoke_signed(core::slice::from_ref(&Signer::from(&seeds)))?;
        let receipt = unsafe { accounts[8].borrow_unchecked_mut() };
        receipt[0..8].copy_from_slice(&PAYOUT_DISCRIMINATOR);
        receipt[8..10].copy_from_slice(&v3::V3_LAYOUT_VERSION.to_le_bytes());
        receipt[10] = bump;
        receipt[RECEIPT_CORE..RECEIPT_CORE + 32].copy_from_slice(core_key.as_ref());
        receipt[RECEIPT_TRADER..RECEIPT_TRADER + 32].copy_from_slice(trader_key.as_ref());
    } else {
        let receipt = unsafe { accounts[8].borrow_unchecked() };
        if !accounts[8].owned_by(program_id)
            || receipt.len() != RECEIPT_SIZE
            || receipt[0..8] != PAYOUT_DISCRIMINATOR
            || receipt[RECEIPT_CORE..RECEIPT_CORE + 32] != *core_key.as_ref()
            || receipt[RECEIPT_TRADER..RECEIPT_TRADER + 32] != *trader_key.as_ref()
        {
            return Err(EquinoxError::InvalidInstruction.into());
        }
    }
    let paid = u64::from_le_bytes(unsafe { accounts[8].borrow_unchecked() }[RECEIPT_TOTAL..RECEIPT_TOTAL + 8].try_into().unwrap());
    let amount = requested.checked_sub(paid).filter(|delta| *delta > 0).ok_or(EquinoxError::InvalidInstruction)?;
    {
        let destination = TokenAccount::from_account_view(&accounts[3]).map_err(|_| EquinoxError::CustodyViolation)?;
        let vault = TokenAccount::from_account_view(&accounts[4]).map_err(|_| EquinoxError::CustodyViolation)?;
        if *destination.owner() != trader_key || *destination.mint() != mint || *vault.mint() != mint || vault.amount() < amount {
            return Err(EquinoxError::CustodyViolation.into());
        }
    }
    let bump_slice = [authority_bump];
    let seeds = [Seed::from(b"vault-authority"), Seed::from(core_key.as_ref()), Seed::from(&bump_slice)];
    Transfer::<&AccountView>::new(&accounts[4], &accounts[3], &accounts[5], amount)
        .invoke_signed_with_program(&[Signer::from(&seeds)], accounts[7].address())?;
    let receipt = unsafe { accounts[8].borrow_unchecked_mut() };
    receipt[RECEIPT_TOTAL..RECEIPT_TOTAL + 8].copy_from_slice(&requested.to_le_bytes());
    Ok(())
}
