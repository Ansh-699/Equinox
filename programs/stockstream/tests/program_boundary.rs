use pinocchio::{error::ProgramError, Address};
use stockstream::instruction::StockStreamInstruction;
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

#[test]
fn production_instruction_decoder_covers_integration_variants() {
    assert!(matches!(
        StockStreamInstruction::decode(&[9]),
        Ok(StockStreamInstruction::InitializeVault)
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[10, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]),
        Ok(StockStreamInstruction::DepositCollateral {
            seat_index: 0,
            amount: 7
        })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[12]),
        Ok(StockStreamInstruction::ConsumeOracleUpdate)
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[14, 1, 0, 0, 0, 0, 0, 0, 0]),
        Ok(StockStreamInstruction::CommitMarket { sequence: 1 })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[17, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]),
        Ok(StockStreamInstruction::AuthorizeTradingSession {
            expires_at: 2,
            nonce: 3
        })
    ));
    let mut instrument = [0u8; 37];
    instrument[0] = 22;
    instrument[33..37].copy_from_slice(&(-2i32).to_le_bytes());
    assert!(matches!(
        StockStreamInstruction::decode(&instrument),
        Ok(StockStreamInstruction::UpdateStockInstrument {
            price_exponent: -2,
            ..
        })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[25]),
        Ok(StockStreamInstruction::TransitionMarket { mode: 0 })
    ));
    let mut risk = [0u8; 9];
    risk[0] = 24;
    risk[1..3].copy_from_slice(&2000u16.to_le_bytes());
    risk[3..5].copy_from_slice(&1000u16.to_le_bytes());
    risk[5..9].copy_from_slice(&5u32.to_le_bytes());
    assert!(matches!(
        StockStreamInstruction::decode(&risk),
        Ok(StockStreamInstruction::UpdateMarketRisk {
            maximum_leverage: 5,
            ..
        })
    ));
}
