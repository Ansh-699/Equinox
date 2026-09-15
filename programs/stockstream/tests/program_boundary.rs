use pinocchio::{error::ProgramError, Address};
use stockstream::{
    error::StockStreamError,
    initialize_market::{validate_initialize_market, AccountAccess},
    instruction::INITIALIZE_MARKET_DISCRIMINATOR,
    process_instruction, ID,
};

const OTHER_PROGRAM_ID: Address = Address::new_from_array([1; 32]);

#[test]
fn empty_instruction_is_rejected() {
    assert_eq!(
        process_instruction(&ID, &mut [], &[]),
        Err(ProgramError::InvalidInstructionData)
    );
}

#[test]
fn unknown_instruction_is_rejected() {
    assert_eq!(
        process_instruction(&ID, &mut [], &[255]),
        Err(ProgramError::InvalidInstructionData)
    );
}

#[test]
fn initialize_market_with_missing_accounts_is_rejected() {
    assert_eq!(
        process_instruction(&ID, &mut [], &[INITIALIZE_MARKET_DISCRIMINATOR]),
        Err(ProgramError::NotEnoughAccountKeys)
    );
}

#[test]
fn initialize_market_requires_authority_signature() {
    let accounts = [
        AccountAccess {
            is_signer: false,
            is_writable: true,
            owner: &ID,
        },
        AccountAccess {
            is_signer: false,
            is_writable: false,
            owner: &OTHER_PROGRAM_ID,
        },
    ];

    assert_eq!(
        validate_initialize_market(&ID, &accounts),
        Err(ProgramError::MissingRequiredSignature)
    );
}

#[test]
fn initialize_market_rejects_wrong_market_owner() {
    let accounts = [
        AccountAccess {
            is_signer: false,
            is_writable: true,
            owner: &OTHER_PROGRAM_ID,
        },
        AccountAccess {
            is_signer: true,
            is_writable: false,
            owner: &OTHER_PROGRAM_ID,
        },
    ];

    assert_eq!(
        validate_initialize_market(&ID, &accounts),
        Err(ProgramError::IllegalOwner)
    );
}

#[test]
fn process_instruction_detects_program_id_mismatch() {
    assert_eq!(
        process_instruction(
            &OTHER_PROGRAM_ID,
            &mut [],
            &[INITIALIZE_MARKET_DISCRIMINATOR]
        ),
        Err(ProgramError::IncorrectProgramId)
    );
}

#[test]
fn initialize_market_requires_a_writable_market() {
    let accounts = [
        AccountAccess {
            is_signer: false,
            is_writable: false,
            owner: &ID,
        },
        AccountAccess {
            is_signer: true,
            is_writable: false,
            owner: &OTHER_PROGRAM_ID,
        },
    ];

    assert_eq!(
        validate_initialize_market(&ID, &accounts),
        Err(StockStreamError::MarketNotWritable.into())
    );
}
