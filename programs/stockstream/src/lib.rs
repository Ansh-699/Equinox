#![no_std]

// The MagicBlock delegation/magic-program API crates pull in a `std`-linked
// `solana-address` build (required, not optional, by their own manifests) for
// the sbpf-solana-solana target. That collides with `nostd_panic_handler!`'s
// own `#[panic_handler]` (duplicate `panic_impl` lang item), so this program
// uses the std-compatible panic handler instead. No heap allocator is added:
// `no_allocator!()` in the entrypoint module is unchanged, so a reachable
// allocation still fails to link rather than silently costing compute.
pinocchio::default_panic_handler!();

pub mod book;
pub mod error;
pub mod handlers;
pub mod initialize_market;
pub mod instruction;
pub mod magicblock;
pub mod registry;
pub mod risk;
pub mod scratch;
pub mod session;
pub mod state;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::instruction::StockStreamInstruction;

pub const ID: Address = Address::new_from_array([
    1, 99, 3, 75, 85, 232, 97, 22, 45, 107, 2, 20, 49, 46, 183, 135, 43, 66, 68, 44, 72, 47, 186,
    41, 46, 239, 86, 185, 49, 154, 84, 255,
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

    // The delegation program's external-undelegate callback uses its own
    // fixed 8-byte discriminator, not StockStream's single-byte instruction
    // tags (see `magicblock::EXTERNAL_UNDELEGATE_DISCRIMINATOR` for why: it
    // is dictated by `magicblock-delegation-program-api`, not by this
    // program). Route it before the normal decode so it can never collide
    // with an opcode.
    if instruction_data.len() >= 8
        && instruction_data[0..8] == magicblock::EXTERNAL_UNDELEGATE_DISCRIMINATOR
    {
        return magicblock::external_undelegate(program_id, accounts, instruction_data);
    }

    let instruction = StockStreamInstruction::decode(instruction_data)?;
    handlers::dispatch(program_id, accounts, instruction, instruction_data)
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
