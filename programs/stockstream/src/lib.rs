#![no_std]

pinocchio::nostd_panic_handler!();

pub mod book;
pub mod error;
pub mod handlers;
pub mod initialize_market;
pub mod instruction;
pub mod risk;
pub mod state;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::instruction::StockStreamInstruction;

pub const ID: Address = Address::new_from_array([
    80, 110, 191, 17, 198, 60, 141, 251, 2, 46, 157, 183, 152, 130, 114, 144, 37, 55, 135, 183,
    214, 85, 224, 205, 241, 32, 82, 25, 49, 154, 84, 255,
]);

// Keep the Phase 2 bounded arena and matcher implementations in the SBF
// artifact. Instruction wiring to a market account is intentionally deferred
// until the account initialization lifecycle is implemented in Phase 3.
#[cfg(feature = "bpf-entrypoint")]
#[used]
static STOCKSTREAM_ARENA_VALIDATOR: fn(&book::Arena) -> Result<(), book::BookError> =
    book::Arena::validate;

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let instruction = StockStreamInstruction::decode(instruction_data)?;
    handlers::dispatch(program_id, accounts, instruction)
}

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint {
    use pinocchio::{no_allocator, program_entrypoint, AccountView, Address, ProgramResult};

    program_entrypoint!(process_instruction);
    no_allocator!();

    fn process_instruction(
        program_id: &Address,
        accounts: &mut [AccountView],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::process_instruction(program_id, accounts, instruction_data)
    }
}
