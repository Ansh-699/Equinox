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
fn v3_risk_update_vector_decodes_all_persisted_fields() {
    let mut data = vec![instruction::UPDATE_MARKET_RISK];
    data.extend_from_slice(&2_000u16.to_le_bytes());
    data.extend_from_slice(&1_000u16.to_le_bytes());
    data.extend_from_slice(&50u16.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&5u16.to_le_bytes());
    data.extend_from_slice(&5u32.to_le_bytes());
    data.extend_from_slice(&100i128.to_le_bytes());
    data.extend_from_slice(&1_000i128.to_le_bytes());
    data.extend_from_slice(&250u16.to_le_bytes());
    assert_eq!(data.len(), 49);
    assert!(matches!(
        StockStreamInstruction::decode(&data),
        Ok(StockStreamInstruction::UpdateV3Risk {
            initial_margin_bps: 2_000,
            maintenance_margin_bps: 1_000,
            liquidation_fee_bps: 50,
            maker_fee_bps: 2,
            taker_fee_bps: 5,
            maximum_leverage: 5,
            maximum_position: 100,
            maximum_open_interest: 1_000,
            mark_deviation_bps: 250,
            vault_surplus: 0,
            withdrawal_buffer: 0,
        })
    ));
}

#[test]
fn v3_risk_update_extended_vector_decodes_surplus_and_buffer() {
    let mut data = vec![instruction::UPDATE_MARKET_RISK];
    data.extend_from_slice(&2_000u16.to_le_bytes());
    data.extend_from_slice(&1_000u16.to_le_bytes());
    data.extend_from_slice(&50u16.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&5u16.to_le_bytes());
    data.extend_from_slice(&5u32.to_le_bytes());
    data.extend_from_slice(&100i128.to_le_bytes());
    data.extend_from_slice(&1_000i128.to_le_bytes());
    data.extend_from_slice(&250u16.to_le_bytes());
    data.extend_from_slice(&400i128.to_le_bytes());
    data.extend_from_slice(&25i128.to_le_bytes());
    assert_eq!(data.len(), 81);
    assert!(matches!(
        StockStreamInstruction::decode(&data),
        Ok(StockStreamInstruction::UpdateV3Risk {
            vault_surplus: 400,
            withdrawal_buffer: 25,
            ..
        })
    ));
}

#[test]
fn v3_reconcile_vault_opcode_decodes_without_authority_payload() {
    assert!(matches!(
        StockStreamInstruction::decode(&[instruction::RECONCILE_VAULT_V3]),
        Ok(StockStreamInstruction::ReconcileVaultV3)
    ));
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
    assert!(matches!(
        StockStreamInstruction::decode(&[stockstream::instruction::CREATE_V3_ACCOUNT, 0, 0]),
        Ok(StockStreamInstruction::CreateV3Account { kind: 0, index: 0 })
    ));
    assert!(matches!(
        StockStreamInstruction::decode(&[stockstream::instruction::CREATE_V3_ACCOUNT, 1, 7]),
        Ok(StockStreamInstruction::CreateV3Account { kind: 1, index: 7 })
    ));
    // The parser rejects bad kinds and bounds before a handler can derive a
    // PDA, preventing malformed flattened page indices from aliasing pages.
    assert!(
        StockStreamInstruction::decode(&[stockstream::instruction::CREATE_V3_ACCOUNT, 1, 18,])
            .is_err()
    );
    assert!(
        StockStreamInstruction::decode(&[stockstream::instruction::CREATE_V3_ACCOUNT, 4, 0,])
            .is_err()
    );
    let mut delegate_v3 = vec![stockstream::instruction::DELEGATE_V3_ACCOUNT, 1, 7];
    delegate_v3.extend_from_slice(&[9; 32]);
    assert!(matches!(
        StockStreamInstruction::decode(&delegate_v3),
        Ok(StockStreamInstruction::DelegateV3Account { kind: 1, index: 7, validator }) if validator == [9; 32]
    ));
}

/// A `TypeScript -> Rust` golden vector for `UpdateExchangeConfig`, encoded
/// exactly as `clients/stockstream/src/index.ts::updateExchangeConfig`
/// would (see its matching TS test,
/// "updateExchangeConfig derives the field mask from provided keys and
/// writes every field at its exact offset" in
/// `clients/stockstream/src/index.test.ts`): only `makerFeeBps`,
/// `takerFeeBps`, and `keeperAuthority` are set.
#[test]
fn typescript_update_exchange_config_vector_decodes_in_rust() {
    use stockstream::instruction::exchange_config_field as field;
    let mut data = vec![0u8; 196];
    data[0] = stockstream::instruction::UPDATE_EXCHANGE_CONFIG;
    let field_mask = field::MAKER_FEE_BPS | field::TAKER_FEE_BPS | field::KEEPER_AUTHORITY;
    data[1..5].copy_from_slice(&field_mask.to_le_bytes());
    let keeper_authority = [42u8; 32];
    data[69..101].copy_from_slice(&keeper_authority);
    data[101..103].copy_from_slice(&10u16.to_le_bytes());
    data[103..105].copy_from_slice(&20u16.to_le_bytes());
    data[188..196].copy_from_slice(&5u64.to_le_bytes());
    match StockStreamInstruction::decode(&data) {
        Ok(StockStreamInstruction::UpdateExchangeConfig {
            field_mask: decoded_mask,
            keeper_authority: decoded_keeper,
            maker_fee_bps,
            taker_fee_bps,
            pause_authority,
            expected_config_sequence,
            ..
        }) => {
            assert_eq!(decoded_mask, field_mask);
            assert_eq!(decoded_keeper, keeper_authority);
            assert_eq!(maker_fee_bps, 10);
            assert_eq!(taker_fee_bps, 20);
            assert_eq!(pause_authority, [0u8; 32]); // present on the wire, zeroed, unmasked
            assert_eq!(expected_config_sequence, 5);
        }
        other => panic!("expected UpdateExchangeConfig, got {}", other.is_ok()),
    }
}
