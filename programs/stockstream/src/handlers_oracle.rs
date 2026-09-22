//! Market-oracle configuration helpers.
//!
//! Oracle configuration is copied from the reviewed registry into a newly
//! initialized market. Trading paths only consume the persisted values.

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::StockStreamError;
use crate::handlers::{initialized_header, market_data, write_header};

use pinocchio::cpi::invoke_with_bounds;
use pinocchio::instruction::{InstructionAccount, InstructionView};
use pinocchio::sysvars::instructions::Instructions;

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
const ED25519_PROGRAM_ID: Address = Address::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);
const VERIFY_MESSAGE_DISCRIMINATOR: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];

/// L1-only Pyth verification which writes only the StockStream snapshot.
/// The Pyth storage and treasury accounts are read/writable only as required
/// by the canonical verifier CPI and are never part of the ER bundle.
pub(crate) fn update_oracle_snapshot_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() != 8 || instruction_data.len() < 107 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let ed_idx = u16::from_le_bytes(instruction_data[1..3].try_into().unwrap());
    let sig_idx = instruction_data[3];
    let message = &instruction_data[4..];
    if message.len() > 512
        || !accounts[0].is_writable()
        || !accounts[0].owned_by(program_id)
        || accounts[1].is_writable()
        || !accounts[2].is_signer()
        || !accounts[2].is_writable()
        || !accounts[3].executable()
        || accounts[3].address() != &PYTH_PROGRAM_ID
        || accounts[4].address() != &PYTH_STORAGE_ID
        || !accounts[4].owned_by(&PYTH_PROGRAM_ID)
        || !accounts[5].is_writable()
        || accounts[6].address() != &SYSTEM_PROGRAM_ID
        || accounts[7].address() != &INSTRUCTIONS_SYSVAR_ID
    {
        return Err(StockStreamError::OracleUnavailable.into());
    }
    {
        let storage = accounts[4].try_borrow()?;
        if storage.len() < 72 || storage[40..72] != accounts[5].address().to_bytes() {
            return Err(StockStreamError::OracleUnavailable.into());
        }
    }
    {
        let sysvar = Instructions::try_from(&accounts[7])?;
        let current = sysvar.load_current_index();
        if ed_idx >= current {
            return Err(StockStreamError::OracleUnavailable.into());
        }
        let ed = sysvar.load_instruction_at(ed_idx as usize)?;
        if ed.get_program_id() != &ED25519_PROGRAM_ID {
            return Err(StockStreamError::OracleUnavailable.into());
        }
        let ed_data = ed.get_instruction_data();
        if ed_data.is_empty() || sig_idx >= ed_data[0] {
            return Err(StockStreamError::OracleUnavailable.into());
        }
    }
    let mut verify_data = [0u8; 527];
    verify_data[..8].copy_from_slice(&VERIFY_MESSAGE_DISCRIMINATOR);
    verify_data[8..12].copy_from_slice(&(message.len() as u32).to_le_bytes());
    verify_data[12..12 + message.len()].copy_from_slice(message);
    verify_data[12 + message.len()..14 + message.len()].copy_from_slice(&ed_idx.to_le_bytes());
    verify_data[14 + message.len()] = sig_idx;
    let metas = [
        InstructionAccount::writable_signer(accounts[2].address()),
        InstructionAccount::readonly(accounts[4].address()),
        InstructionAccount::writable(accounts[5].address()),
        InstructionAccount::readonly(accounts[6].address()),
        InstructionAccount::readonly(accounts[7].address()),
    ];
    let cpi_accounts = [
        &accounts[2],
        &accounts[4],
        &accounts[5],
        &accounts[6],
        &accounts[7],
    ];
    invoke_with_bounds::<5, _>(
        &InstructionView {
            program_id: accounts[3].address(),
            accounts: &metas,
            data: &verify_data[..15 + message.len()],
        },
        &cpi_accounts,
    )?;
    let verified = super::parse_verified_oracle(message)?;
    let now = crate::handlers::current_unix_timestamp()?;
    if verified.feed_update_timestamp_us > verified.envelope_timestamp_us || now < 0 {
        return Err(StockStreamError::OracleUnavailable.into());
    }
    let timestamp = verified.feed_update_timestamp_us / 1_000_000;
    let core = accounts[1].try_borrow()?;
    // The snapshot is intentionally updateable on L1 while the execution
    // bundle is delegated.  In that state MagicBlock owns the core account;
    // the core remains read-only here and its bytes are still checked below.
    // Accept only StockStream or the canonical delegation program owner.
    if !(accounts[1].owned_by(program_id)
        || accounts[1].owned_by(&crate::magicblock::DELEGATION_PROGRAM_ID))
        || core.len() != crate::v3::V3_MARKET_CORE_SIZE
        || core[0..8] != crate::v3::V3_MARKET_CORE_DISCRIMINATOR
        || core
            [crate::v3::V3_CORE_ORACLE_FEED_ID_OFFSET..crate::v3::V3_CORE_ORACLE_FEED_ID_OFFSET + 4]
            != verified.feed_id.to_le_bytes()
        || core[crate::v3::V3_CORE_ORACLE_CHANNEL_OFFSET] != verified.channel
        || i32::from(verified.exponent)
            != i32::from_le_bytes(
                core[crate::v3::V3_CORE_ORACLE_EXPONENT_OFFSET
                    ..crate::v3::V3_CORE_ORACLE_EXPONENT_OFFSET + 4]
                    .try_into()
                    .unwrap(),
            )
        || verified.price <= 0
        || verified.confidence < 0
        || verified.confidence as u64 > verified.price.unsigned_abs() / 5
        || timestamp > now as u64 + 2
        || now as u64 > timestamp.saturating_add(crate::v3::V3_MAX_ORACLE_AGE_SECONDS)
    {
        return Err(StockStreamError::OracleUnavailable.into());
    }
    crate::oracle_snapshot::validate_writer(&core, accounts[2].address())?;
    drop(core);
    let core_address = *accounts[1].address();
    let snap = unsafe { accounts[0].borrow_unchecked_mut() };
    crate::oracle_snapshot::write_verified(
        snap,
        &core_address,
        verified.feed_id,
        verified.channel,
        i32::from(verified.exponent),
        verified.price,
        verified.confidence as u64,
        timestamp,
        u8::try_from(verified.session).map_err(|_| StockStreamError::OracleUnavailable)?,
        now as u64,
    )?;
    Ok(())
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
