//! Priority 9: `UpdateExchangeConfig` -- production handler tests.

use core::{mem::size_of, ptr};

use pinocchio::{
    account::{AccountView, RuntimeAccount, NOT_BORROWED},
    Address,
};
use stockstream::{
    instruction::exchange_config_field as field,
    process_instruction,
    registry::{EXCHANGE_DISCRIMINATOR, EXCHANGE_SIZE},
    ID,
};

struct TestAccount {
    _storage: Vec<u64>,
    view: AccountView,
}

fn account(
    address: Address,
    owner: Address,
    data_len: usize,
    signer: bool,
    writable: bool,
) -> TestAccount {
    let words = (size_of::<RuntimeAccount>() + data_len).div_ceil(size_of::<u64>());
    let mut storage = vec![0u64; words];
    let raw = storage.as_mut_ptr() as *mut RuntimeAccount;
    unsafe {
        ptr::write(
            raw,
            RuntimeAccount {
                borrow_state: NOT_BORROWED,
                is_signer: signer as u8,
                is_writable: writable as u8,
                executable: 0,
                padding: [0; 4],
                address,
                owner,
                lamports: 1,
                data_len: data_len as u64,
            },
        );
    }
    let view = unsafe { AccountView::new_unchecked(raw) };
    TestAccount {
        _storage: storage,
        view,
    }
}

/// Builds a real `UpdateExchangeConfig` instruction: opcode + field_mask +
/// every field in its exact wire position (unset fields are zeroed, since
/// the field mask -- not their value -- is what makes them ignored).
struct UpdateExchangeConfigBuilder {
    field_mask: u32,
    pause_authority: [u8; 32],
    emergency_authority: [u8; 32],
    keeper_authority: [u8; 32],
    maker_fee_bps: u16,
    taker_fee_bps: u16,
    liquidation_fee_bps: u16,
    default_initial_margin_bps: u16,
    default_maintenance_margin_bps: u16,
    default_maximum_leverage: u32,
    collateral_mint: [u8; 32],
    oracle_program: [u8; 32],
    insurance_target_balance: u64,
    protocol_status: u8,
    expected_config_sequence: u64,
}

impl Default for UpdateExchangeConfigBuilder {
    fn default() -> Self {
        Self {
            field_mask: 0,
            pause_authority: [0; 32],
            emergency_authority: [0; 32],
            keeper_authority: [0; 32],
            maker_fee_bps: 0,
            taker_fee_bps: 0,
            liquidation_fee_bps: 0,
            default_initial_margin_bps: 0,
            default_maintenance_margin_bps: 0,
            default_maximum_leverage: 0,
            collateral_mint: [0; 32],
            oracle_program: [0; 32],
            insurance_target_balance: 0,
            protocol_status: 0,
            expected_config_sequence: 0,
        }
    }
}

impl UpdateExchangeConfigBuilder {
    fn encode(&self) -> Vec<u8> {
        let mut data = vec![40u8]; // UPDATE_EXCHANGE_CONFIG
        data.extend_from_slice(&self.field_mask.to_le_bytes());
        data.extend_from_slice(&self.pause_authority);
        data.extend_from_slice(&self.emergency_authority);
        data.extend_from_slice(&self.keeper_authority);
        data.extend_from_slice(&self.maker_fee_bps.to_le_bytes());
        data.extend_from_slice(&self.taker_fee_bps.to_le_bytes());
        data.extend_from_slice(&self.liquidation_fee_bps.to_le_bytes());
        data.extend_from_slice(&self.default_initial_margin_bps.to_le_bytes());
        data.extend_from_slice(&self.default_maintenance_margin_bps.to_le_bytes());
        data.extend_from_slice(&self.default_maximum_leverage.to_le_bytes());
        data.extend_from_slice(&self.collateral_mint);
        data.extend_from_slice(&self.oracle_program);
        data.extend_from_slice(&self.insurance_target_balance.to_le_bytes());
        data.push(self.protocol_status);
        data.extend_from_slice(&self.expected_config_sequence.to_le_bytes());
        assert_eq!(data.len(), 196);
        data
    }
}

struct Fixture {
    exchange: TestAccount,
    authority: TestAccount,
}

fn fixture() -> Fixture {
    let authority_addr = Address::new_from_array([70; 32]);
    let exchange = account(
        Address::new_from_array([71; 32]),
        ID,
        EXCHANGE_SIZE,
        false,
        true,
    );
    let authority = account(authority_addr, Address::default(), 0, true, false);
    process_instruction(
        &ID,
        &mut [exchange.view.clone(), authority.view.clone()],
        &[19],
    )
    .unwrap();
    Fixture {
        exchange,
        authority,
    }
}

fn config_sequence(f: &Fixture) -> u64 {
    let data = unsafe { f.exchange.view.borrow_unchecked() };
    u64::from_le_bytes(data[230..238].try_into().unwrap())
}

#[test]
fn updates_pause_authority_alone_and_preserves_every_other_field() {
    let f = fixture();
    let before = unsafe { f.exchange.view.borrow_unchecked() }.to_vec();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::PAUSE_AUTHORITY;
    update.pause_authority = [9; 32];
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &update.encode()).unwrap();
    let after = unsafe { f.exchange.view.borrow_unchecked() }.to_vec();
    assert_eq!(&after[47..79], &[9u8; 32]);
    // Everything outside pause_authority and config_sequence is unchanged.
    assert_eq!(&before[0..47], &after[0..47]);
    assert_eq!(&before[79..230], &after[79..230]);
    assert_eq!(config_sequence(&f), 1);
}

#[test]
fn updates_multiple_fields_in_one_instruction() {
    let f = fixture();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::MAKER_FEE_BPS | field::TAKER_FEE_BPS | field::PROTOCOL_STATUS;
    update.maker_fee_bps = 10;
    update.taker_fee_bps = 20;
    update.protocol_status = 1; // Paused
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &update.encode()).unwrap();
    let data = unsafe { f.exchange.view.borrow_unchecked() };
    assert_eq!(u16::from_le_bytes(data[143..145].try_into().unwrap()), 10);
    assert_eq!(u16::from_le_bytes(data[145..147].try_into().unwrap()), 20);
    assert_eq!(data[229], 1);
}

#[test]
fn rejects_wrong_authority() {
    let f = fixture();
    let impostor = account(
        Address::new_from_array([99; 32]),
        Address::default(),
        0,
        true,
        false,
    );
    let before = unsafe { f.exchange.view.borrow_unchecked() }.to_vec();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::MAKER_FEE_BPS;
    update.maker_fee_bps = 5;
    let mut accounts = [f.exchange.view.clone(), impostor.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
    assert_eq!(before, unsafe { f.exchange.view.borrow_unchecked() });
}

#[test]
fn rejects_wrong_exchange_account() {
    let f = fixture();
    let mut not_the_exchange = account(
        Address::new_from_array([72; 32]),
        ID,
        EXCHANGE_SIZE,
        false,
        true,
    );
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::MAKER_FEE_BPS;
    update.maker_fee_bps = 5;
    let mut accounts = [not_the_exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
    let _ = &mut not_the_exchange; // never initialized: discriminator check must reject it
}

#[test]
fn rejects_fees_above_the_hard_safety_bound() {
    let f = fixture();
    let before = unsafe { f.exchange.view.borrow_unchecked() }.to_vec();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::MAKER_FEE_BPS;
    update.maker_fee_bps = 1_001; // MAX_FEE_BPS is 1_000
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
    assert_eq!(before, unsafe { f.exchange.view.borrow_unchecked() });
}

#[test]
fn rejects_maintenance_margin_exceeding_initial_margin() {
    let f = fixture();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::DEFAULT_INITIAL_MARGIN_BPS | field::DEFAULT_MAINTENANCE_MARGIN_BPS;
    update.default_initial_margin_bps = 500;
    update.default_maintenance_margin_bps = 600; // exceeds initial
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
}

#[test]
fn rejects_maximum_leverage_above_the_hard_cap() {
    let f = fixture();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::DEFAULT_MAXIMUM_LEVERAGE;
    update.default_maximum_leverage = 126; // MAX_DEFAULT_LEVERAGE is 125
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
}

#[test]
fn rejects_a_zero_authority_pubkey() {
    let f = fixture();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::KEEPER_AUTHORITY;
    update.keeper_authority = [0; 32];
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
}

#[test]
fn field_mask_cannot_touch_the_immutable_listing_authority_or_instrument_count() {
    // There is no field-mask bit for `authority`/`instrument_count` at all
    // -- an out-of-range mask bit is rejected outright rather than being
    // silently ignored, which would otherwise be the only way such a bit
    // could ever be "supported" by a future, careless change.
    let f = fixture();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = 1 << 31; // far beyond ALL_KNOWN
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
}

#[test]
fn rejects_a_stale_config_sequence() {
    let f = fixture();
    let mut first = UpdateExchangeConfigBuilder::default();
    first.field_mask = field::MAKER_FEE_BPS;
    first.maker_fee_bps = 5;
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &first.encode()).unwrap();
    assert_eq!(config_sequence(&f), 1);

    // Replaying the same instruction (still claiming sequence 0) must fail.
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &first.encode()).is_err());

    // The correct next sequence succeeds.
    let mut second = UpdateExchangeConfigBuilder::default();
    second.field_mask = field::TAKER_FEE_BPS;
    second.taker_fee_bps = 6;
    second.expected_config_sequence = 1;
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    process_instruction(&ID, &mut accounts, &second.encode()).unwrap();
    assert_eq!(config_sequence(&f), 2);
}

#[test]
fn rejects_a_zero_field_mask_no_op_update() {
    let f = fixture();
    let update = UpdateExchangeConfigBuilder::default(); // field_mask: 0
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
    assert_eq!(config_sequence(&f), 0);
}

#[test]
fn a_failed_update_leaves_every_byte_untouched() {
    let f = fixture();
    let before = unsafe { f.exchange.view.borrow_unchecked() }.to_vec();
    let mut update = UpdateExchangeConfigBuilder::default();
    update.field_mask = field::MAKER_FEE_BPS | field::DEFAULT_MAXIMUM_LEVERAGE;
    update.maker_fee_bps = 5;
    update.default_maximum_leverage = 999; // fails the hard cap, after maker_fee_bps would have applied
    let mut accounts = [f.exchange.view.clone(), f.authority.view.clone()];
    assert!(process_instruction(&ID, &mut accounts, &update.encode()).is_err());
    assert_eq!(before, unsafe { f.exchange.view.borrow_unchecked() });
}

#[test]
fn exchange_config_version_is_bumped_and_discriminator_is_stable() {
    let f = fixture();
    let data = unsafe { f.exchange.view.borrow_unchecked() };
    assert_eq!(&data[0..8], &EXCHANGE_DISCRIMINATOR);
    assert_eq!(u16::from_le_bytes(data[8..10].try_into().unwrap()), 2);
}
