use stockstream::instruction::{self, StockStreamInstruction};

/// Every StockStream instruction opcode must be a unique byte. This is a
/// mechanical safety net, not a design decision -- `decode` already
/// switches on the opcode first in every arm (never on data length
/// alone), so a collision here would mean two entirely different
/// instructions silently aliasing onto the same wire byte.
#[test]
fn every_instruction_opcode_is_unique() {
    let opcodes: [(&str, u8); 40] = [
        ("INITIALIZE_MARKET", instruction::INITIALIZE_MARKET),
        ("CREATE_TRADER_SEAT", instruction::CREATE_TRADER_SEAT),
        ("CLOSE_TRADER_SEAT", instruction::CLOSE_TRADER_SEAT),
        ("PLACE_ORDER", instruction::PLACE_ORDER),
        ("CANCEL_ORDER", instruction::CANCEL_ORDER),
        ("CANCEL_ALL", instruction::CANCEL_ALL),
        ("UPDATE_FUNDING", instruction::UPDATE_FUNDING),
        ("LIQUIDATE", instruction::LIQUIDATE),
        (
            "INITIALIZE_SETTLEMENT_SCRATCH",
            instruction::INITIALIZE_SETTLEMENT_SCRATCH,
        ),
        ("INITIALIZE_VAULT", instruction::INITIALIZE_VAULT),
        ("DEPOSIT_COLLATERAL", instruction::DEPOSIT_COLLATERAL),
        ("WITHDRAW_COLLATERAL", instruction::WITHDRAW_COLLATERAL),
        ("CONSUME_ORACLE_UPDATE", instruction::CONSUME_ORACLE_UPDATE),
        ("DELEGATE_MARKET", instruction::DELEGATE_MARKET),
        ("COMMIT_MARKET", instruction::COMMIT_MARKET),
        ("COMMIT_AND_UNDELEGATE", instruction::COMMIT_AND_UNDELEGATE),
        (
            "UNDELEGATION_CALLBACK_RESERVED",
            instruction::UNDELEGATION_CALLBACK_RESERVED,
        ),
        (
            "AUTHORIZE_TRADING_SESSION",
            instruction::AUTHORIZE_TRADING_SESSION,
        ),
        (
            "REVOKE_TRADING_SESSION",
            instruction::REVOKE_TRADING_SESSION,
        ),
        ("INITIALIZE_EXCHANGE", instruction::INITIALIZE_EXCHANGE),
        (
            "REGISTER_STOCK_INSTRUMENT",
            instruction::REGISTER_STOCK_INSTRUMENT,
        ),
        ("CREATE_PERP_MARKET", instruction::CREATE_PERP_MARKET),
        (
            "UPDATE_STOCK_INSTRUMENT",
            instruction::UPDATE_STOCK_INSTRUMENT,
        ),
        (
            "SUSPEND_STOCK_INSTRUMENT",
            instruction::SUSPEND_STOCK_INSTRUMENT,
        ),
        ("UPDATE_MARKET_RISK", instruction::UPDATE_MARKET_RISK),
        ("PAUSE_MARKET", instruction::PAUSE_MARKET),
        ("RESUME_MARKET", instruction::RESUME_MARKET),
        ("SET_CLOSE_ONLY", instruction::SET_CLOSE_ONLY),
        (
            "ENTER_CORPORATE_ACTION",
            instruction::ENTER_CORPORATE_ACTION,
        ),
        (
            "RESOLVE_CORPORATE_ACTION",
            instruction::RESOLVE_CORPORATE_ACTION,
        ),
        ("CLOSE_MARKET", instruction::CLOSE_MARKET),
        (
            "UPDATE_TRADING_SESSION_LIMITS",
            instruction::UPDATE_TRADING_SESSION_LIMITS,
        ),
        ("CLOSE_TRADING_SESSION", instruction::CLOSE_TRADING_SESSION),
        ("REPLACE_ORDER", instruction::REPLACE_ORDER),
        (
            "TRANSFER_TO_INSURANCE_FUND",
            instruction::TRANSFER_TO_INSURANCE_FUND,
        ),
        (
            "WITHDRAW_PROTOCOL_FEES",
            instruction::WITHDRAW_PROTOCOL_FEES,
        ),
        (
            "WITHDRAW_INSURANCE_FUNDS",
            instruction::WITHDRAW_INSURANCE_FUNDS,
        ),
        ("RECORD_BAD_DEBT", instruction::RECORD_BAD_DEBT),
        ("RESOLVE_BAD_DEBT", instruction::RESOLVE_BAD_DEBT),
        ("RECONCILE_VAULT", instruction::RECONCILE_VAULT),
    ];
    let mut seen = std::collections::HashMap::new();
    for (name, opcode) in opcodes {
        if let Some(previous) = seen.insert(opcode, name) {
            panic!("opcode {opcode} used by both {previous} and {name}");
        }
    }
    assert_eq!(seen.len(), 40, "expected exactly 40 unique opcodes");
}

/// A truncated payload for an instruction with a fixed-length body must be
/// rejected, never decoded with missing fields defaulted or zero-filled.
#[test]
fn truncated_payloads_are_rejected_not_defaulted() {
    // PLACE_ORDER expects 54 bytes; one byte short must reject.
    let mut place_order = vec![instruction::PLACE_ORDER];
    place_order.extend_from_slice(&[0u8; 52]);
    assert!(StockStreamInstruction::decode(&place_order).is_err());
    // CREATE_TRADER_SEAT expects 3 bytes; a bare opcode must reject.
    assert!(StockStreamInstruction::decode(&[instruction::CREATE_TRADER_SEAT]).is_err());
}

/// Extra, unsupported trailing bytes past an instruction's exact expected
/// length must be rejected -- this program's decode policy requires an
/// exact length match per opcode, never "at least N bytes."
#[test]
fn trailing_unsupported_bytes_are_rejected() {
    let mut place_order = vec![instruction::PLACE_ORDER];
    place_order.extend_from_slice(&[0u8; 53]); // correct length (54 total, including the opcode byte)
    assert!(StockStreamInstruction::decode(&place_order).is_ok());
    place_order.push(0xff); // one extra byte past the exact expected length
    assert!(StockStreamInstruction::decode(&place_order).is_err());
}

/// An opcode byte with no registered instruction at all must reject.
#[test]
fn unknown_opcode_is_rejected() {
    assert!(StockStreamInstruction::decode(&[200]).is_err());
    assert!(
        StockStreamInstruction::decode(&[instruction::UNDELEGATION_CALLBACK_RESERVED]).is_err()
    );
}

#[test]
fn typescript_golden_instruction_vectors_decode_in_rust() {
    assert!(matches!(
        StockStreamInstruction::decode(&[0]),
        Ok(StockStreamInstruction::InitializeMarket)
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[1, 7, 0]),
        Ok(StockStreamInstruction::CreateTraderSeat { seat_index: 7 })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[2, 7, 0]),
        Ok(StockStreamInstruction::CloseTraderSeat { seat_index: 7 })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[5, 7, 0, 8, 9, 0, 0, 0, 0, 0, 0, 0]),
        Ok(StockStreamInstruction::CancelAll {
            seat_index: 7,
            max_cancellations: 8,
            action_nonce: 9,
        })
    ));
    let cancel = [
        4, 7, 0, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0,
    ];
    assert!(matches!(
        StockStreamInstruction::decode(&cancel),
        Ok(StockStreamInstruction::CancelOrder {
            seat_index: 7,
            order_key: 0x01020304050607,
            action_nonce: 8,
        })
    ));
}
