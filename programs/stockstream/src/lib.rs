#![no_std]

// The MagicBlock delegation/magic-program API crates used to pull a
// `std`-linked `solana-address` build into this target, which forced the
// std-compatible panic handler. They are dev-dependencies only now (see
// `magicblock.rs`): that std linkage is exactly what made the linker tag the
// SBF ELF `ELFOSABI_GNU`, a header the SBF loader rejects outright. With the
// graph fully `no_std` the standard no-std panic handler applies. No heap
// allocator is added: `no_allocator!()` in the entrypoint module is
// unchanged, so a reachable allocation still fails to link rather than
// silently costing compute.
pinocchio::nostd_panic_handler!();

pub mod book;
pub mod error;
pub mod events;
pub mod handlers;
pub mod initialize_market;
pub mod instruction;
pub mod magicblock;
pub mod mark;
pub mod registry;
pub mod risk;
pub mod scratch;
pub mod session;
pub mod state;
pub mod v3;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::instruction::StockStreamInstruction;

pub const ID: Address = Address::new_from_array([
    238, 93, 151, 107, 197, 15, 150, 255, 50, 108, 58, 155, 4, 9, 32, 48, 102, 97, 106, 199, 17,
    221, 77, 89, 193, 85, 47, 160, 102, 163, 179, 240,
]);

// The Phase 2 `#[used] static STOCKSTREAM_ARENA_VALIDATOR` that used to live
// here is gone: `handlers::place_order_core` now calls `Arena::validate`
// directly on both arenas, so the arena/matcher code is reachable from the
// entrypoint and needs no retention anchor. Removing it also drops the
// `SHF_GNU_RETAIN` section flag LLVM emits for `#[used]` statics, which was
// making lld tag the whole ELF `ELFOSABI_GNU` -- a header the SBF loader
// rejects (`solana-sbpf`'s `ElfError::WrongAbi`).

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
