use stockstream::instruction::StockStreamInstruction;

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
