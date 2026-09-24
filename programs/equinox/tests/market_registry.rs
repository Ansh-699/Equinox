use pinocchio::Address;
use equinox::{
    registry::{derive_instrument, derive_perp_market, EXCHANGE_SIZE, INSTRUMENT_SIZE},
    ID,
};

#[test]
fn instrument_and_perp_market_addresses_are_market_scoped() {
    let exchange = Address::new_from_array([9; 32]);
    let apple = [1; 32];
    let tesla = [2; 32];
    let apple_instrument = derive_instrument(&ID, &exchange, &apple);
    let tesla_instrument = derive_instrument(&ID, &exchange, &tesla);
    assert_ne!(apple_instrument, tesla_instrument);
    assert_ne!(
        derive_perp_market(&ID, &apple_instrument),
        derive_perp_market(&ID, &tesla_instrument)
    );
    assert_eq!(EXCHANGE_SIZE, 256);
    assert_eq!(INSTRUMENT_SIZE, 128);
}

#[test]
fn registry_instruction_shapes_are_decoded() {
    assert!(matches!(
        equinox::instruction::EquinoxInstruction::decode(&[19]),
        Ok(equinox::instruction::EquinoxInstruction::InitializeExchange)
    ));
    let mut data = [0u8; 33];
    data[0] = 20;
    data[1..].fill(7);
    assert!(
        matches!(equinox::instruction::EquinoxInstruction::decode(&data), Ok(equinox::instruction::EquinoxInstruction::RegisterStockInstrument { instrument_id }) if instrument_id == [7; 32])
    );
}
