#![cfg(feature = "runtime-tests")]
//! Real-SVM runtime tests for the settlement path.
//!
//! These drive the actual source-built `stockstream.so` inside LiteSVM through
//! real serialized transactions -- no native processor substitute, no direct
//! `process_instruction` call. The host suites (`account_settlement.rs`) only
//! observe one handler in isolation; the properties worth proving here belong
//! to the *runtime*:
//!
//!   * an instruction either commits or changes nothing,
//!   * `ReplaceOrder`'s cancel-then-place really is atomic,
//!   * account bytes are restored exactly on failure,
//!   * self-trade prevention is enforced by the deployed program.
//!
//! Instruction encodings mirror `account_settlement.rs` byte-for-byte.
//! Collateral is seeded by patching the seat region of the market account
//! directly (test setup), exactly as the host fixture does.

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
    book::{OrderInput, SelfTradeBehavior, Side, TimeInForce, TreeKind},
    scratch::{derive_settlement_scratch, SETTLEMENT_SCRATCH_LEN},
    state::{
        MarketMode, MarketStateHeader, TraderSeat, MARKET_ACCOUNT_SIZE, TRADER_SEAT_OFFSET,
        TRADER_SEAT_SIZE,
    },
    ID,
};

const SEAT_A: u16 = 0;
const SEAT_B: u16 = 1;

/// Two distinct traders, so a genuine cross is possible. Seat A's owner is also
/// the fee payer for every transaction.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Trader {
    A,
    B,
}

fn program_path() -> PathBuf {
    std::env::var_os("STOCKSTREAM_TEST_SBF")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
        })
}

fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}

fn readonly_signer(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, true)
}

struct Env {
    svm: LiteSVM,
    authority: Keypair,
    maker: Keypair,
    market: Address,
}

impl Env {
    fn keypair(&self, trader: Trader) -> &Keypair {
        match trader {
            Trader::A => &self.authority,
            Trader::B => &self.maker,
        }
    }

    fn seat_index(trader: Trader) -> u16 {
        match trader {
            Trader::A => SEAT_A,
            Trader::B => SEAT_B,
        }
    }

    fn send(
        &mut self,
        trader: Trader,
        data: &[u8],
        accounts: &[AccountMeta],
    ) -> Result<(), String> {
        let instruction = Instruction {
            program_id: ID,
            accounts: accounts.to_vec(),
            data: data.to_vec(),
        };
        let message = Message::new(&[instruction], Some(&self.authority.pubkey()));
        let blockhash = self.svm.latest_blockhash();
        let transaction = match trader {
            Trader::A => Transaction::new(&[&self.authority], message, blockhash),
            Trader::B => Transaction::new(&[&self.authority, &self.maker], message, blockhash),
        };
        self.svm
            .send_transaction(transaction)
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    }

    fn scratch(&self, seat: u16) -> Address {
        derive_settlement_scratch(&self.market, seat, &ID)
    }

    fn market_data(&self) -> Vec<u8> {
        self.svm.get_account(&self.market).unwrap().data
    }

    fn write_market_data(&mut self, data: Vec<u8>) {
        let mut account = self.svm.get_account(&self.market).unwrap();
        account.data = data;
        self.svm.set_account(self.market, account).unwrap();
    }

    /// Test setup only: open the market and seed oracle/config fields, exactly
    /// as `account_settlement.rs::set_open_oracle` does.
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
            (*header).market_authority = authority;
            (*header).pause_authority = authority;
            (*header).emergency_authority = authority;
        }
        self.write_market_data(data);
    }

    fn credit(&mut self, seat: u16, amount: i128) {
        let mut data = self.market_data();
        unsafe {
            let base = data
                .as_mut_ptr()
                .add(TRADER_SEAT_OFFSET + seat as usize * TRADER_SEAT_SIZE);
            let mut view = ptr::read_unaligned(base as *const TraderSeat);
            view.available_collateral = amount;
            ptr::write_unaligned(base as *mut TraderSeat, view);
        }
        self.write_market_data(data);
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

    fn position(&self, seat: u16) -> i128 {
        let data = self.market_data();
        unsafe {
            let base = data
                .as_ptr()
                .add(TRADER_SEAT_OFFSET + seat as usize * TRADER_SEAT_SIZE);
            ptr::read_unaligned(base as *const TraderSeat).base_position
        }
    }

    fn header(&self) -> MarketStateHeader {
        unsafe { ptr::read_unaligned(self.market_data().as_ptr() as *const MarketStateHeader) }
    }

    fn create_seat(&mut self, trader: Trader) -> Result<(), String> {
        let mut data = vec![1u8];
        data.extend_from_slice(&Self::seat_index(trader).to_le_bytes());
        let market = self.market;
        let owner = self.keypair(trader).pubkey();
        self.send(trader, &data, &[writable(market), readonly_signer(owner)])
    }

    fn init_scratch(&mut self, trader: Trader) -> Result<(), String> {
        let seat = Self::seat_index(trader);
        let mut data = vec![8u8];
        data.extend_from_slice(&seat.to_le_bytes());
        let market = self.market;
        let owner = self.keypair(trader).pubkey();
        let scratch = self.scratch(seat);
        // The program validates an already-allocated, program-owned PDA of the
        // exact length rather than creating it (System-Program funding is a
        // separate runtime lifecycle milestone), so the fixture allocates it.
        self.svm
            .set_account(
                scratch,
                Account {
                    lamports: 10_000_000,
                    data: vec![0; SETTLEMENT_SCRATCH_LEN],
                    owner: ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        self.send(
            trader,
            &data,
            &[writable(market), readonly_signer(owner), writable(scratch)],
        )
    }

    fn order_data(
        side: u8,
        seat: u16,
        quantity: u64,
        price: i64,
        flags: u8,
        client: u64,
        action_nonce: u64,
    ) -> Vec<u8> {
        let mut data = vec![3, side, 0, flags, 0, 0];
        data[4..6].copy_from_slice(&seat.to_le_bytes());
        data.extend_from_slice(&quantity.to_le_bytes());
        data.extend_from_slice(&price.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        data.extend_from_slice(&client.to_le_bytes());
        data.extend_from_slice(&action_nonce.to_le_bytes());
        data
    }

    fn place(&mut self, trader: Trader, data: &[u8]) -> Result<(), String> {
        let market = self.market;
        let owner = self.keypair(trader).pubkey();
        let scratch = self.scratch(Self::seat_index(trader));
        self.send(
            trader,
            data,
            &[writable(market), readonly_signer(owner), writable(scratch)],
        )
    }

    fn replace(&mut self, trader: Trader, old_key: u128, new_order: &[u8]) -> Result<(), String> {
        let mut data = vec![33u8];
        data.extend_from_slice(&old_key.to_le_bytes());
        data.extend_from_slice(&new_order[1..]);
        self.place(trader, &data)
    }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");

    let authority = Keypair::new();
    let maker = Keypair::new();
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
        maker,
        market,
    };
    env.send(
        Trader::A,
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

/// Seeds both seats, both scratch accounts and collateral.
fn ready(credit: i128) -> Env {
    let mut env = setup();
    env.create_seat(Trader::A).expect("CreateTraderSeat A");
    env.init_scratch(Trader::A).expect("InitializeScratch A");
    env.create_seat(Trader::B).expect("CreateTraderSeat B");
    env.init_scratch(Trader::B).expect("InitializeScratch B");
    env.credit(SEAT_A, credit);
    env.credit(SEAT_B, credit);
    env
}

#[test]
fn account_lifecycle_binds_each_seat_to_its_owner() {
    let env = ready(1_000_000);
    assert_eq!(
        env.seat(SEAT_A).trader,
        env.authority.pubkey().to_bytes(),
        "seat A belongs to the first signer"
    );
    assert_eq!(env.seat(SEAT_B).trader, env.maker.pubkey().to_bytes());
    let collateral = env.seat(SEAT_A).available_collateral;
    assert_eq!(collateral, 1_000_000);
    assert_eq!(env.header().initialized, 1);
}

#[test]
fn a_resting_order_is_accepted_and_advances_the_order_sequence() {
    let mut env = ready(1_000_000);
    let order = Env::order_data(1, SEAT_A, 10, 100, 0, 701, 0);
    env.place(Trader::A, &order)
        .expect("resting ask must be accepted");
    let sequence = env.header().global_order_sequence;
    assert_eq!(sequence, 1);
}

/// A genuine two-trader cross. Host tests cover the accounting; this adds that
/// the deployed program executes the settlement path in a real SVM and leaves
/// the scratch account reusable.
#[test]
fn a_crossing_order_fills_against_the_other_seat() {
    let mut env = ready(1_000_000);
    let resting = Env::order_data(1, SEAT_A, 10, 100, 0, 701, 0);
    env.place(Trader::A, &resting).expect("resting ask from A");
    let crossing = Env::order_data(0, SEAT_B, 4, 110, 0, 702, 0);
    env.place(Trader::B, &crossing)
        .expect("crossing bid from B");

    assert_eq!(env.position(SEAT_A), -4, "seat A sold into the bid");
    assert_eq!(env.position(SEAT_B), 4, "seat B bought the ask");
    let sequence = env.header().global_order_sequence;
    assert_eq!(sequence, 2, "both orders consumed one sequence each");

    // The same scratch account must be reusable by a later instruction.
    let again = Env::order_data(0, SEAT_B, 1, 99, 0, 703, 0);
    env.place(Trader::B, &again)
        .expect("scratch must be Empty and reusable after settlement");
}

/// Self-trade prevention enforced by the deployed program: seat A's bid must
/// not be allowed to cross seat A's own resting ask.
#[test]
fn self_trade_abort_is_enforced_by_the_runtime() {
    let mut env = ready(1_000_000);
    let resting = Env::order_data(1, SEAT_A, 10, 100, 0, 701, 0);
    env.place(Trader::A, &resting).expect("resting ask from A");

    let market_before = env.market_data();
    let self_cross = Env::order_data(0, SEAT_A, 4, 110, 0, 702, 0);
    let result = env.place(Trader::A, &self_cross);
    assert!(result.is_err(), "a same-owner cross must be refused");
    assert_eq!(
        env.market_data(),
        market_before,
        "a refused self-trade must leave the market byte-for-byte unchanged"
    );
}

/// The property host tests structurally cannot prove: `ReplaceOrder` cancels
/// the old order first and then places the new one, so a failure in the second
/// stage must be rolled back by the runtime.
#[test]
fn replace_order_failure_is_rolled_back_by_the_runtime() {
    let mut env = ready(1_000_000);
    let resting = Env::order_data(1, SEAT_A, 10, 100, 0, 701, 0);
    env.place(Trader::A, &resting).expect("resting ask");

    let old_key = OrderInput {
        side: Side::Ask,
        tree: TreeKind::Fixed,
        owner: SEAT_A as u32,
        price_or_offset: 100,
        sequence: 1,
        quantity: 10,
        expires_at: 0,
        peg_limit: 0,
        client_order_id: 701,
        time_in_force: TimeInForce::GoodTilCancelled,
        post_only: false,
        self_trade_behavior: SelfTradeBehavior::AbortTransaction,
    }
    .leaf()
    .unwrap()
    .key;

    let market_before = env.market_data();
    let scratch_address = env.scratch(SEAT_A);
    let scratch_before = env.svm.get_account(&scratch_address).unwrap().data;

    // Notional 10_000_000 * 101 massively exceeds the seat's 1_000_000
    // collateral, so the placement stage fails *after* the cancel stage ran.
    let doomed = Env::order_data(0, SEAT_A, 10_000_000, 101, 0, 702, 0);
    let result = env.replace(Trader::A, old_key, &doomed);
    assert!(result.is_err(), "the replacement stage must fail");

    assert_eq!(
        env.market_data(),
        market_before,
        "runtime rollback must restore the market byte-for-byte (old order, reserve, sequences)"
    );
    assert_eq!(
        env.svm.get_account(&scratch_address).unwrap().data,
        scratch_before,
        "runtime rollback must restore the scratch account byte-for-byte"
    );
}

#[test]
fn invalid_input_reaches_a_program_defined_error_not_a_loader_error() {
    let mut env = ready(1_000_000);
    let market = env.market;
    let signer = env.authority.pubkey();
    let scratch = env.scratch(SEAT_A);
    let error = env
        .send(
            Trader::A,
            &[255],
            &[writable(market), readonly_signer(signer), writable(scratch)],
        )
        .expect_err("unknown opcode must fail");
    assert!(
        !error.contains("Incompatible ELF"),
        "must be a program error, not a loader error: {error}"
    );
}
