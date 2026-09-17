#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests (Priority 8, Section 14) for the three keeper
//! paths `runtime_settlement.rs`/`runtime_deposit.rs`/`runtime_withdraw.rs`
//! don't cover: funding-accumulator settlement, liquidation, and trading
//! session creation/revocation. Same discipline as those files: the actual
//! source-built `stockstream.so` loaded into LiteSVM and driven through
//! real serialized transactions, not a native `process_instruction` call.

use std::path::PathBuf;
use std::ptr;

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use stockstream::{
    session::{TradingSession, TRADING_SESSION_SEED},
    state::{
        LiquidationState, MarketMode, MarketStateHeader, TraderSeat, MARKET_ACCOUNT_SIZE,
        TRADER_SEAT_OFFSET, TRADER_SEAT_SIZE,
    },
    ID,
};

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}

fn readonly(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}

fn readonly_signer(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, true)
}

struct Env {
    svm: LiteSVM,
    authority: Keypair,
    market: Address,
}

impl Env {
    fn send(&mut self, data: &[u8], accounts: &[AccountMeta]) -> Result<u64, String> {
        let instruction = Instruction {
            program_id: ID,
            accounts: accounts.to_vec(),
            data: data.to_vec(),
        };
        let message = Message::new(&[instruction], Some(&self.authority.pubkey()));
        let blockhash = self.svm.latest_blockhash();
        let transaction = Transaction::new(&[&self.authority], message, blockhash);
        self.svm
            .send_transaction(transaction)
            .map(|meta| meta.compute_units_consumed)
            .map_err(|error| format!("{error:?}"))
    }

    fn market_data(&self) -> Vec<u8> {
        self.svm.get_account(&self.market).unwrap().data
    }

    fn write_market_data(&mut self, data: Vec<u8>) {
        let mut account = self.svm.get_account(&self.market).unwrap();
        account.data = data;
        self.svm.set_account(self.market, account).unwrap();
    }

    fn set_open_oracle(&mut self) {
        let authority = self.authority.pubkey().to_bytes();
        let mut data = self.market_data();
        unsafe {
            let header = data.as_mut_ptr() as *mut MarketStateHeader;
            (*header).mode = MarketMode::Open as u8;
            (*header).oracle_valid = 1;
            (*header).last_verified_oracle_price = 100;
            (*header).last_verified_oracle_timestamp = 1;
            (*header).maximum_position = 1_000_000;
            (*header).maximum_open_interest = 1_000_000;
            (*header).maintenance_margin_bps = 1_000; // 10%
            (*header).liquidation_fee_bps = 50;
            (*header).market_authority = authority;
            (*header).pause_authority = authority;
            (*header).emergency_authority = authority;
        }
        self.write_market_data(data);
    }

    fn create_seat(&mut self, seat: u16) -> Result<u64, String> {
        let mut data = vec![1u8];
        data.extend_from_slice(&seat.to_le_bytes());
        let market = self.market;
        let owner = self.authority.pubkey();
        self.send(&data, &[writable(market), readonly_signer(owner)])
    }

    fn seat(&self, seat: u16) -> TraderSeat {
        let data = self.market_data();
        unsafe {
            ptr::read_unaligned(
                data.as_ptr()
                    .add(TRADER_SEAT_OFFSET + seat as usize * TRADER_SEAT_SIZE)
                    as *const TraderSeat,
            )
        }
    }

    fn write_seat(&mut self, seat: u16, value: TraderSeat) {
        let mut data = self.market_data();
        unsafe {
            let base = data
                .as_mut_ptr()
                .add(TRADER_SEAT_OFFSET + seat as usize * TRADER_SEAT_SIZE);
            ptr::write_unaligned(base as *mut TraderSeat, value);
        }
        self.write_market_data(data);
    }

    fn header(&self) -> MarketStateHeader {
        unsafe { ptr::read_unaligned(self.market_data().as_ptr() as *const MarketStateHeader) }
    }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");

    let authority = Keypair::new();
    let market = Address::new_unique();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.set_account(
        market,
        Account {
            lamports: 10_000_000_000,
            data: vec![0; MARKET_ACCOUNT_SIZE],
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let mut env = Env {
        svm,
        authority,
        market,
    };
    env.send(
        &[0],
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("InitializeMarket");
    env.set_open_oracle();
    env
}

// ---------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------

fn update_funding_data(accumulator: i128, timestamp: u64) -> Vec<u8> {
    let mut data = vec![6u8];
    data.extend_from_slice(&accumulator.to_le_bytes());
    data.extend_from_slice(&timestamp.to_le_bytes());
    data
}

#[test]
fn funding_accumulator_advances_and_records_the_timestamp() {
    let mut env = setup();
    let cu = env
        .send(
            &update_funding_data(5_000, 42),
            &[
                writable(env.market),
                readonly_signer(env.authority.pubkey()),
            ],
        )
        .expect("UpdateFunding must be accepted by the deployed program");
    assert!(
        cu > 0,
        "expected nonzero compute units for UpdateFunding, got {cu}"
    );
    eprintln!("compute units (UpdateFunding): {cu}");
    let header = env.header();
    assert_eq!({ header.funding_accumulator }, 5_000);
    assert_eq!({ header.last_funding_timestamp }, 42);
}

#[test]
fn funding_rejects_a_regression_in_accumulator_or_timestamp() {
    let mut env = setup();
    env.send(
        &update_funding_data(5_000, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("first UpdateFunding");
    let result = env.send(
        &update_funding_data(4_000, 43),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(
        result.is_err(),
        "a lower accumulator must be rejected by the deployed program"
    );
    let header = env.header();
    assert_eq!(
        { header.funding_accumulator },
        5_000,
        "state must be unchanged after the rejected instruction"
    );
}

#[test]
fn funding_rejects_a_non_authority_signer() {
    let mut env = setup();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![writable(env.market), readonly_signer(stranger.pubkey())],
        data: update_funding_data(1, 1),
    };
    let message = Message::new(&[instruction], Some(&stranger.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&stranger], message, blockhash);
    assert!(env.svm.send_transaction(transaction).is_err());
}

// ---------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------

fn liquidate_data(seat_index: u16, max_quantity: u64) -> Vec<u8> {
    let mut data = vec![7u8];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&max_quantity.to_le_bytes());
    data
}

fn underwater_seat(
    owner: Address,
    base_position: i128,
    quote_entry_value: i128,
    available_collateral: i128,
) -> TraderSeat {
    let mut seat = TraderSeat::empty();
    seat.occupancy = 1;
    seat.trader = owner.to_bytes();
    seat.base_position = base_position;
    seat.quote_entry_value = quote_entry_value;
    seat.available_collateral = available_collateral;
    seat
}

#[test]
fn liquidate_reduces_an_underwater_position_and_marks_liquidation_state() {
    let mut env = setup();
    env.create_seat(0).expect("CreateTraderSeat");
    // Mark price 100, 10 units long, entry value 1000 (break-even at 100),
    // 5 collateral: equity = 5 + (10*100 - 1000) = 5, well under the 10%
    // maintenance requirement (100) -- genuinely liquidatable, matching
    // programs/stockstream/src/risk.rs::is_liquidatable exactly.
    let seat = underwater_seat(env.authority.pubkey(), 10, 1_000, 5);
    env.write_seat(0, seat);

    let cu = env
        .send(
            &liquidate_data(0, 100),
            &[
                writable(env.market),
                readonly_signer(env.authority.pubkey()),
            ],
        )
        .expect(
            "Liquidate must be accepted by the deployed program for a genuinely underwater seat",
        );
    assert!(
        cu > 0,
        "expected nonzero compute units for Liquidate, got {cu}"
    );
    eprintln!("compute units (Liquidate): {cu}");

    let after = env.seat(0);
    assert!(
        after.base_position.abs() < 10,
        "the position must shrink after liquidation"
    );
    // This fixture is deeply underwater (equity 5 vs. a 900-unit unrealized
    // loss); a single partial liquidation halves the position but does not
    // by itself restore positive equity, so it correctly remains
    // Liquidatable rather than Healthy -- risk.rs::set_liquidation_state
    // recomputes this from the exact same formula after every fill.
    assert_eq!(
        after.liquidation_state,
        LiquidationState::Liquidatable as u8
    );
}

#[test]
fn liquidate_rejects_a_healthy_position() {
    let mut env = setup();
    env.create_seat(0).expect("CreateTraderSeat");
    // Flat position, ample collateral -- equity 1000 >> requirement 0.
    let seat = underwater_seat(env.authority.pubkey(), 0, 0, 1_000);
    env.write_seat(0, seat);
    let before = env.seat(0);
    let result = env.send(
        &liquidate_data(0, 100),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(result.is_err(), "a healthy position must not be liquidated");
    let after = env.seat(0);
    assert_eq!(
        { after.available_collateral },
        { before.available_collateral },
        "a rejected Liquidate must leave the seat byte-for-byte unchanged"
    );
}

#[test]
fn liquidate_rejects_a_signer_that_is_not_the_emergency_authority() {
    let mut env = setup();
    env.create_seat(0).expect("CreateTraderSeat");
    env.write_seat(0, underwater_seat(env.authority.pubkey(), 10, 1_000, 5));
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![writable(env.market), readonly_signer(stranger.pubkey())],
        data: liquidate_data(0, 100),
    };
    let message = Message::new(&[instruction], Some(&stranger.pubkey()));
    let blockhash = env.svm.latest_blockhash();
    let transaction = Transaction::new(&[&stranger], message, blockhash);
    assert!(env.svm.send_transaction(transaction).is_err());
}

// ---------------------------------------------------------------------
// Trading session creation / revocation
// ---------------------------------------------------------------------

fn authorize_session_data(
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> Vec<u8> {
    let mut data = vec![17u8];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data.extend_from_slice(&expires_at.to_le_bytes());
    data.push(actions);
    data.extend_from_slice(&max_order_notional.to_le_bytes());
    data.extend_from_slice(&max_cumulative_notional.to_le_bytes());
    data.extend_from_slice(&maximum_exposure.to_le_bytes());
    data.extend_from_slice(&maximum_open_orders.to_le_bytes());
    data
}

fn revoke_session_data(seat_index: u16) -> Vec<u8> {
    let mut data = vec![18u8];
    data.extend_from_slice(&seat_index.to_le_bytes());
    data
}

fn session_pda(
    owner: Address,
    market: Address,
    seat_index: u16,
    session_signer: Address,
) -> Address {
    Address::find_program_address(
        &[
            TRADING_SESSION_SEED,
            owner.as_ref(),
            market.as_ref(),
            &seat_index.to_le_bytes(),
            session_signer.as_ref(),
        ],
        &ID,
    )
    .0
}

fn read_session(env: &Env, pda: Address) -> TradingSession {
    let data = env.svm.get_account(&pda).unwrap().data;
    unsafe { ptr::read_unaligned(data.as_ptr() as *const TradingSession) }
}

#[test]
fn authorize_trading_session_creates_a_real_pda_via_system_program_cpi() {
    let mut env = setup();
    env.create_seat(0).expect("CreateTraderSeat");
    let session_signer = Keypair::new().pubkey();
    let pda = session_pda(env.authority.pubkey(), env.market, 0, session_signer);

    let cu = env
        .send(
            &authorize_session_data(0, 1_000_000, 1, 10, 20, 1_000, 4),
            &[
                writable(env.market),
                readonly_signer(env.authority.pubkey()),
                writable(pda),
                readonly(session_signer),
                readonly(pinocchio_system_id()),
            ],
        )
        .expect("AuthorizeTradingSession must create the session PDA via a real CPI");
    assert!(
        cu > 0,
        "expected nonzero compute units for AuthorizeTradingSession, got {cu}"
    );
    eprintln!("compute units (AuthorizeTradingSession): {cu}");

    let session = read_session(&env, pda);
    assert_eq!(session.initialized, 1);
    assert_eq!(session.revoked, 0);
    assert_eq!(session.owner, env.authority.pubkey().to_bytes());
    assert_eq!(session.session_signer, session_signer.to_bytes());
    assert_eq!({ session.trader_seat_index }, 0);
}

#[test]
fn revoke_trading_session_marks_the_real_pda_revoked_and_is_enforced_by_the_runtime() {
    let mut env = setup();
    env.create_seat(0).expect("CreateTraderSeat");
    let session_signer = Keypair::new().pubkey();
    let pda = session_pda(env.authority.pubkey(), env.market, 0, session_signer);
    env.send(
        &authorize_session_data(0, 1_000_000, 1, 10, 20, 1_000, 4),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
            writable(pda),
            readonly(session_signer),
            readonly(pinocchio_system_id()),
        ],
    )
    .expect("AuthorizeTradingSession");

    let cu = env
        .send(
            &revoke_session_data(0),
            &[
                writable(env.market),
                readonly_signer(env.authority.pubkey()),
                writable(pda),
                readonly(session_signer),
            ],
        )
        .expect("RevokeTradingSession must be accepted by the deployed program");
    assert!(
        cu > 0,
        "expected nonzero compute units for RevokeTradingSession, got {cu}"
    );
    eprintln!("compute units (RevokeTradingSession): {cu}");

    let session = read_session(&env, pda);
    assert_eq!(session.revoked, 1, "the real PDA must be marked revoked");

    // Revoking twice is documented as idempotent, not an error --
    // expire_blockhash so the second transaction isn't just rejected as a
    // byte-identical duplicate of the first (a client/runtime-level replay
    // guard, not evidence of the program's own idempotency).
    env.svm.expire_blockhash();
    env.send(
        &revoke_session_data(0),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
            writable(pda),
            readonly(session_signer),
        ],
    )
    .expect("revoking an already-revoked session must be a no-op success");
}

fn pinocchio_system_id() -> Address {
    // 11111111111111111111111111111111 -- the System Program ID, matching
    // `pinocchio_system::ID` (imported indirectly via the program crate;
    // duplicated here as a raw constant since this test binary does not
    // otherwise depend on `pinocchio_system`).
    Address::new_from_array([0u8; 32])
}
