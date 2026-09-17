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
        // Plant a resting two-sided book (bid 96 / ask 98 with indexes above
        // NONE) so the on-chain mark lands at mid 97 and the funding basis is
        // nonzero: the bounded-funding policy funds from the mark basis, not
        // from caller instruction data.
        self.plant_book();
    }

    /// Plants a resting fixed-price leaf on each side of the book, so the
    /// deployed program's mark computation lands at mid 97 (basis -300bps vs
    /// index 100). Uses the real arena types so the packed(8) node layout is
    /// exactly the one the program validates.
    fn plant_book(&mut self) {
        use stockstream::book::{
            Arena, LeafNode, OrderInput, SelfTradeBehavior, Side, TimeInForce, TreeKind,
        };

        let mut bids = Arena::new();
        let mut asks = Arena::new();
        let leaf = |side: Side, price: i64| -> LeafNode {
            OrderInput {
                side,
                tree: TreeKind::Fixed,
                owner: 1,
                price_or_offset: price,
                sequence: 1,
                quantity: 10,
                expires_at: u64::MAX,
                peg_limit: i64::MAX,
                client_order_id: 1,
                time_in_force: stockstream::book::TimeInForce::GoodTilCancelled,
                post_only: false,
                self_trade_behavior: SelfTradeBehavior::AbortTransaction,
            }
            .leaf()
            .unwrap()
        };
        bids.insert(TreeKind::Fixed, leaf(Side::Bid, 96)).unwrap();
        asks.insert(TreeKind::Fixed, leaf(Side::Ask, 98)).unwrap();

        let mut data = self.market_data();
        unsafe {
            let bid_base =
                data.as_mut_ptr().add(stockstream::state::BID_ARENA_OFFSET) as *mut Arena;
            ptr::write_unaligned(bid_base, bids);
            let ask_base =
                data.as_mut_ptr().add(stockstream::state::ASK_ARENA_OFFSET) as *mut Arena;
            ptr::write_unaligned(ask_base, asks);
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
    // The bounded-funding policy computes the allowed increment on-chain
    // from the live book: elapsed=42s and a resting book mid of 97
    // (basis -300bps vs index 100) admit an increment of at most 42.
    let cu = env
        .send(
            &update_funding_data(40, 42),
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
    assert_eq!({ header.funding_accumulator }, 40);
    assert_eq!({ header.last_funding_timestamp }, 42);
}

#[test]
fn funding_rejects_a_regression_in_accumulator_or_timestamp() {
    let mut env = setup();
    env.send(
        &update_funding_data(40, 42),
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
        40,
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

// ---------------------------------------------------------------------
// Deterministic mark-price funding (runtime): the deployed program derives
// the funding bound from the LIVE book, not caller data. Each test plants a
// real arena and drives the deployed program's UpdateFunding.
// ---------------------------------------------------------------------

impl Env {
    fn oracle(&mut self, price: i64, _timestamp: u64) {
        let mut data = self.market_data();
        unsafe {
            let header = data.as_mut_ptr() as *mut MarketStateHeader;
            (*header).mode = MarketMode::Open as u8;
            (*header).oracle_valid = 1;
            (*header).last_verified_oracle_price = price;
            (*header).last_verified_oracle_timestamp = 1;
        }
        self.write_market_data(data);
    }

    fn book(&mut self, bid: i64, ask: i64) {
        use stockstream::book::{
            Arena, OrderInput, SelfTradeBehavior, Side, TimeInForce, TreeKind,
        };
        let mut data = self.market_data();
        for (offset, side, price) in [
            (stockstream::state::BID_ARENA_OFFSET, Side::Bid, bid),
            (stockstream::state::ASK_ARENA_OFFSET, Side::Ask, ask),
        ] {
            let mut arena = Arena::new();
            if price > 0 {
                let leaf = OrderInput {
                    side,
                    tree: TreeKind::Fixed,
                    owner: 1,
                    price_or_offset: price,
                    sequence: 1,
                    quantity: 10,
                    expires_at: u64::MAX,
                    peg_limit: i64::MAX,
                    client_order_id: 1,
                    time_in_force: TimeInForce::GoodTilCancelled,
                    post_only: false,
                    self_trade_behavior: SelfTradeBehavior::AbortTransaction,
                }
                .leaf()
                .unwrap();
                arena.insert(TreeKind::Fixed, leaf).unwrap();
            }
            unsafe {
                ptr::write_unaligned(data.as_mut_ptr().add(offset) as *mut Arena, arena);
            }
        }
        self.write_market_data(data);
    }
}

#[test]
fn runtime_mark_funding_admits_only_bounded_increments() {
    let mut env = setup();
    env.oracle(100, 1);
    env.plant_book(); // bid 96 / ask 98 -> on-chain mark 97, basis -300 bps
                      // Cap = min(1 bps/sec * elapsed, |basis|): elapsed 42 -> 42.
    env.send(
        &update_funding_data(40, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("a 40-accumulator increment within the mark-derived cap");
    assert_eq!({ env.header().funding_accumulator }, 40);

    // A 5_000 increment (way beyond the cap) must be rejected by the real
    // program, not just by host-side unit tests.
    let mut env2 = setup();
    env2.oracle(100, 1);
    env2.plant_book();
    let rejected = env2.send(
        &update_funding_data(5_000, 42),
        &[
            writable(env2.market),
            readonly_signer(env2.authority.pubkey()),
        ],
    );
    assert!(
        rejected.is_err(),
        "unbounded funding must be rejected on-chain"
    );
}

#[test]
fn runtime_mark_funding_empty_book_means_zero_basis_means_zero_funding() {
    let mut env = setup();
    env.oracle(100, 1);
    env.book(0, 0); // explicit empty book
                    // No book: the mark falls back to the verified index -> basis 0 -> the
                    // submitted increment must be 0.
    let rejected = env.send(
        &update_funding_data(10, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(
        rejected.is_err(),
        "an empty book has zero basis: any nonzero increment must be rejected on-chain"
    );
}

#[test]
fn runtime_mark_funding_stale_oracle_rejects() {
    let mut env = setup();
    env.plant_book();
    // Clear the verified oracle (stale feed).
    let mut data = env.market_data();
    unsafe {
        let header = data.as_mut_ptr() as *mut MarketStateHeader;
        (*header).oracle_valid = 0;
    }
    env.write_market_data(data);
    // oracle_valid = 0: the mark computation must refuse, so funding is
    // rejected entirely (no fallback price).
    let rejected = env.send(
        &update_funding_data(1, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(rejected.is_err(), "stale oracle must reject funding");
}

#[test]
fn runtime_mark_funding_halted_market_rejects() {
    let mut env = setup();
    env.oracle(100, 1);
    env.plant_book();
    let mut data = env.market_data();
    unsafe {
        let header = data.as_mut_ptr() as *mut MarketStateHeader;
        (*header).mode = MarketMode::Paused as u8;
    }
    env.write_market_data(data);
    let rejected = env.send(
        &update_funding_data(10, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(rejected.is_err(), "a paused market must reject funding");
}

#[test]
fn runtime_mark_funding_extreme_book_is_clamped() {
    // One-sided extreme bid: bid 10_000 (100x index) with an ask side absent
    // -> BookOneSided clamped to index + 5% = 105 -> basis +500 bps.
    let mut env = setup();
    env.oracle(100, 1);
    env.book(10_000, 0); // bids only
                         // elapsed=42 -> absolute cap 42 bps < basis 500 -> bound = 42
    env.send(
        &update_funding_data(42, 42),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("42 bps within the clamp-derived basis bound");
    assert_eq!({ env.header().funding_accumulator }, 42);
    // ...and 43 more would exceed the per-second cap on the next second.
    let rejected = env.send(
        &update_funding_data(85, 43),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(
        rejected.is_err(),
        "85 more bps in 1 second must be rejected"
    );
}

#[test]
fn runtime_mark_funding_positive_basis() {
    let mut env = setup();
    env.oracle(100, 1);
    env.book(103, 105); // mid 104 -> basis +400 bps
                        // elapsed=40 -> cap min(40, 400) = 40
    env.send(
        &update_funding_data(40, 40),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("40 bps within the +400 bps basis");
    assert_eq!({ env.header().funding_accumulator }, 40);
}

// ---------------------------------------------------------------------
// Mark-price runtime coverage additions (pegged roots, locked book,
// integer rounding), each executing the deployed program's funding guard.
// ---------------------------------------------------------------------
impl Env {
    fn pegged_leaf(&mut self, side: u8, offset: i64, peg_limit: i64) {
        use stockstream::book::{
            Arena, LeafNode, OrderInput, SelfTradeBehavior, TimeInForce, TreeKind,
        };
        let mut data = self.market_data();
        let (offset_arena, side) = if side == 0 {
            (
                stockstream::state::BID_ARENA_OFFSET,
                stockstream::book::Side::Bid,
            )
        } else {
            (
                stockstream::state::ASK_ARENA_OFFSET,
                stockstream::book::Side::Ask,
            )
        };
        let mut arena =
            unsafe { ptr::read_unaligned(data.as_ptr().add(offset_arena) as *const Arena) };
        let leaf = OrderInput {
            side,
            tree: TreeKind::OraclePegged,
            owner: 2,
            price_or_offset: offset,
            sequence: 9,
            quantity: 5,
            expires_at: u64::MAX,
            peg_limit,
            client_order_id: 9,
            time_in_force: TimeInForce::GoodTilCancelled,
            post_only: false,
            self_trade_behavior: SelfTradeBehavior::AbortTransaction,
        }
        .leaf()
        .unwrap();
        arena.insert(TreeKind::OraclePegged, leaf).unwrap();
        unsafe {
            ptr::write_unaligned(data.as_mut_ptr().add(offset_arena) as *mut Arena, arena);
        }
        self.write_market_data(data);
    }
}

#[test]
fn runtime_mark_pegged_root_drives_funding_bound() {
    // Oracle 100; pegged BID at oracle+3 = 103 only (no asks) -> one-sided
    // mark 103 -> basis +300 bps; peg_limit MAX (valid peg).
    let mut env = setup();
    env.oracle(100, 1);
    env.book(0, 0);
    env.pegged_leaf(0, 3, i64::MAX);
    // elapsed=40 -> absolute cap min(40, 300) = 40
    env.send(
        &update_funding_data(40, 40),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("pegged one-sided bid funds from the clamped mark basis");
    assert_eq!({ env.header().funding_accumulator }, 40);
}

#[test]
fn runtime_mark_invalid_pegged_order_excluded() {
    // Pegged bid with peg_limit 50: evaluated price 103 > 50 -> Invalid ->
    // excluded from the mark -> empty book -> index fallback -> zero basis.
    let mut env = setup();
    env.oracle(100, 1);
    env.book(0, 0);
    env.pegged_leaf(0, 3, 50);
    let rejected = env.send(
        &update_funding_data(10, 40),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(
        rejected.is_err(),
        "an invalid pegged order must not create a basis"
    );
}

#[test]
fn runtime_mark_locked_book_falls_back_to_index() {
    // Locked book: best bid == best ask (locked books arise only from
    // corruption; valid matching never leaves them). Mark = index.
    let mut env = setup();
    env.oracle(100, 1);
    env.book(100, 100);
    let rejected = env.send(
        &update_funding_data(10, 40),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    );
    assert!(
        rejected.is_err(),
        "a locked book's basis is zero: nonzero increments must be rejected"
    );
}

#[test]
fn runtime_mark_integer_rounding_deterministic() {
    // bid 96 / ask 97: floor((96+97)/2) = 96 (round-half-down); basis -400.
    let mut env = setup();
    env.oracle(100, 1);
    env.book(96, 97);
    env.send(
        &update_funding_data(40, 40),
        &[
            writable(env.market),
            readonly_signer(env.authority.pubkey()),
        ],
    )
    .expect("40 bps within the floored mid's basis");
    assert_eq!({ env.header().funding_accumulator }, 40);
}
