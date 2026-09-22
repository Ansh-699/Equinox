use stockstream::instruction::StockStreamInstruction;

#[test]
fn authorize_trading_session_v3_golden_bytes_decode() {
    // Golden bytes shared with clients/stockstream/src/index.test.ts.  The
    // layout is opcode, u16 seat, u64 expiry, u8 actions, two u64 limits,
    // signed i128 exposure, and u16 maximum-open-orders, all little-endian.
    let bytes = hex_bytes(
        "11070008070605040302011f887766554433221100ffeeddccbbaa99100f0e0d0c0b0a0908070605040302013412",
    );
    let decoded = StockStreamInstruction::decode(&bytes).expect("canonical session bytes decode");
    match decoded {
        StockStreamInstruction::AuthorizeTradingSession {
            seat_index,
            expires_at,
            actions,
            max_order_notional,
            max_cumulative_notional,
            maximum_exposure,
            maximum_open_orders,
        } => {
            assert_eq!(seat_index, 7);
            assert_eq!(expires_at, 0x0102_0304_0506_0708);
            assert_eq!(actions, 0x1f);
            assert_eq!(max_order_notional, 0x1122_3344_5566_7788);
            assert_eq!(max_cumulative_notional, 0x99aa_bbcc_ddee_ff00);
            assert_eq!(maximum_exposure, 0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10);
            assert_eq!(maximum_open_orders, 0x1234);
        }
        _ => panic!("unexpected decoded instruction variant"),
    }
}

fn hex_bytes(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}
