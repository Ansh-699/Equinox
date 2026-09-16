//! Priority 7: a complete, versioned, binary StockStream event ABI.
//!
//! Every event is one `sol_log_data` syscall carrying exactly `EVENT_SIZE`
//! bytes: a fixed `EventHeader` (discriminator, ABI version, the market's
//! own monotonic event sequence, market pubkey, and the protocol timestamp
//! that produced the state change) followed by a fixed `EVENT_PAYLOAD_SIZE`
//! payload whose interpretation depends on the discriminator (documented
//! per `EventKind` below, mirrored byte-for-byte in
//! `clients/stockstream/src/index.ts::decodeStockStreamEvent`).
//!
//! This replaces the earlier Priority-4 custody-only text format
//! (`SS:<Kind> market=... seq=...`, `pinocchio_log`-based `msg!` lines) with
//! real binary program-data logging, per the real Solana `sol_log_data`
//! syscall contract (`solana-program::log::sol_log_data`, verified against
//! `solana-define-syscall` v2.3.0's `define_syscall!` macro expansion,
//! which is either a plain `extern "C" fn(data: *const u8, data_len: u64)`
//! or, under the `static-syscalls` target feature, a `murmur3_32` hash of
//! the syscall's name transmuted to a function pointer -- the exact same
//! pattern `pinocchio_log` already uses for `sol_log_`. `sol_log_data`'s
//! own hash (`1930933300`) was computed by an independent from-scratch
//! implementation of the documented `murmur3_32(name, seed=0)` algorithm,
//! cross-checked against the *known* published hash for `sol_log_`
//! (`544561597`, the literal `pinocchio_log` already hardcodes) to confirm
//! the implementation reproduces the real algorithm before trusting it for
//! a value with no independent public confirmation).
//!
//! `sol_log_data(data: &[&[u8]])`'s wire contract is Rust's own in-memory
//! representation of a fat-pointer slice of fat-pointer slices -- the
//! syscall receives `data.as_ptr()` cast to `*const u8` and `data.len()`,
//! and the runtime walks that exact memory layout. This program only ever
//! passes a single field (`[bytes]`), so each event surfaces to an indexer
//! as one `Program data: <base64>` log line carrying the complete
//! `EVENT_SIZE`-byte record.
//!
//! No heap allocation anywhere in this path: `EventHeader` is a
//! `#[repr(C, packed(1))]` fixed-size struct, and every payload is built in
//! a fixed-size `[u8; EVENT_PAYLOAD_SIZE]` stack array.

use core::mem::size_of;

pub const EVENT_ABI_VERSION: u8 = 1;
pub const EVENT_PAYLOAD_SIZE: usize = 48;
/// Sentinel `seat_index` meaning "this event is market-level, not
/// attributable to one trader seat" (funding-accumulator updates,
/// custody-ledger changes, reconciliation, ...).
pub const NO_SEAT: u16 = u16::MAX;

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct EventHeader {
    pub discriminator: u16,
    pub abi_version: u8,
    pub reserved: u8,
    pub sequence: u64,
    pub market: [u8; 32],
    pub timestamp: u64,
}
pub const EVENT_HEADER_SIZE: usize = size_of::<EventHeader>();
pub const EVENT_SIZE: usize = EVENT_HEADER_SIZE + EVENT_PAYLOAD_SIZE;
const _: [(); 52] = [(); EVENT_HEADER_SIZE];
const _: [(); 100] = [(); EVENT_SIZE];

/// Every StockStream event kind. Values are stable across ABI versions --
/// a kind is never renumbered or reused, only added. Grouped by area for
/// readability; the numeric bands (1xx per area) leave room to add more
/// kinds within a group without renumbering anything else.
#[repr(u16)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventKind {
    // Exchange and registry -- `RegistryPayload` (instrument_id) or empty.
    ExchangeInitialized = 100,
    ExchangeConfigUpdated = 101,
    StockInstrumentRegistered = 102,
    StockInstrumentUpdated = 103,
    StockInstrumentSuspended = 104,
    PerpMarketCreated = 105,
    MarketRiskUpdated = 106,
    MarketPaused = 107,
    MarketResumed = 108,
    MarketCloseOnly = 109,
    CorporateActionEntered = 110,
    CorporateActionResolved = 111,
    MarketClosed = 112,

    // Trader and orders -- `OrderPayload` / `FillPayload` / `SeatPayload`.
    TraderSeatCreated = 200,
    TraderSeatClosed = 201,
    OrderPlaced = 202,
    OrderPartiallyFilled = 203,
    OrderFilled = 204,
    OrderCancelled = 205,
    CancelAllProgress = 206,
    OrderReplaced = 207,
    OrderExpired = 208,
    InvalidOrderRemoved = 209,
    SelfTradePrevented = 210,

    // Positions and risk -- `PositionPayload` / `FundingPayload` / `LiquidationPayload`.
    PositionChanged = 300,
    MarginChanged = 301,
    FundingAccumulatorUpdated = 302,
    FundingSettled = 303,
    LiquidationStarted = 304,
    PositionLiquidated = 305,
    BankruptcyRecorded = 306,
    InsuranceApplied = 307,

    // Custody -- `SeatAmountPayload` (seat = NO_SEAT for market-level) or `ReconciliationPayload`.
    VaultInitialized = 400,
    CollateralDeposited = 401,
    CollateralWithdrawn = 402,
    ProtocolFeesChanged = 403,
    InsuranceFundChanged = 404,
    BadDebtRecorded = 405,
    BadDebtResolved = 406,
    VaultSurplusDetected = 407,
    VaultDeficitDetected = 408,
    VaultReconciled = 409,

    // Oracle -- `OraclePayload`.
    OracleUpdated = 500,
    OracleRejected = 501,
    MarketSessionChanged = 502,
    TradingStatusChanged = 503,
    OracleStale = 504,
    OracleRecovered = 505,

    // MagicBlock -- `DelegationPayload`.
    DelegationRequested = 600,
    MarketDelegated = 601,
    CommitRequested = 602,
    CommitSequenceChanged = 603,
    UndelegationRequested = 604,
    RestorationPending = 605,
    MarketRestored = 606,
    DelegationErrorState = 607,

    // Sessions -- `SessionPayload`.
    TradingSessionAuthorized = 700,
    TradingSessionLimitsUpdated = 701,
    TradingSessionActionConsumed = 702,
    TradingSessionRevoked = 703,
    TradingSessionClosed = 704,
}

#[cfg(all(target_os = "solana", not(target_feature = "static-syscalls")))]
mod syscall {
    extern "C" {
        pub fn sol_log_data(data: *const u8, data_len: u64);
    }
}
#[cfg(all(target_os = "solana", target_feature = "static-syscalls"))]
mod syscall {
    /// Murmur3-32("sol_log_data", seed=0) -- see the module doc for how
    /// this was derived and cross-checked.
    const SOL_LOG_DATA_HASH: usize = 1_930_933_300;
    #[inline]
    pub unsafe fn sol_log_data(data: *const u8, data_len: u64) {
        let syscall: extern "C" fn(*const u8, u64) = core::mem::transmute(SOL_LOG_DATA_HASH);
        syscall(data, data_len)
    }
}

fn log_bytes(bytes: &[u8]) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    unsafe {
        let fields: [&[u8]; 1] = [bytes];
        syscall::sol_log_data(fields.as_ptr() as *const u8, fields.len() as u64);
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    core::hint::black_box(bytes);
}

/// Pure encoding, exposed separately from `emit_event` so tests can assert
/// on the exact bytes without depending on the `sol_log_data` syscall
/// (which no-ops off the SBF target, like every other CPI/syscall boundary
/// in this program -- see `docs/magicblock.md`).
pub fn encode_event(
    kind: EventKind,
    market: &[u8; 32],
    sequence: u64,
    timestamp: u64,
    payload: &[u8; EVENT_PAYLOAD_SIZE],
) -> [u8; EVENT_SIZE] {
    let header = EventHeader {
        discriminator: kind as u16,
        abi_version: EVENT_ABI_VERSION,
        reserved: 0,
        sequence,
        market: *market,
        timestamp,
    };
    let mut bytes = [0u8; EVENT_SIZE];
    // SAFETY: `EventHeader` is `repr(C, packed(1))` with an exact,
    // stable byte layout, and `EVENT_HEADER_SIZE` is asserted at compile
    // time to equal `size_of::<EventHeader>()`.
    unsafe {
        core::ptr::copy_nonoverlapping(
            &header as *const EventHeader as *const u8,
            bytes.as_mut_ptr(),
            EVENT_HEADER_SIZE,
        );
    }
    bytes[EVENT_HEADER_SIZE..].copy_from_slice(payload);
    bytes
}

/// Encodes and emits one event. `sequence` should be the market's own
/// `global_event_sequence` *after* being advanced for this event (matching
/// the existing fill-event/custody-event convention), so it is directly
/// comparable across every event kind for gap detection.
pub fn emit_event(
    kind: EventKind,
    market: &[u8; 32],
    sequence: u64,
    timestamp: u64,
    payload: &[u8; EVENT_PAYLOAD_SIZE],
) {
    log_bytes(&encode_event(kind, market, sequence, timestamp, payload));
}

// ---------------------------------------------------------------------
// Fixed-size payload builders. Each documents its own exact byte layout
// (offsets within the 48-byte payload), matched byte-for-byte by the
// TypeScript decoder.
// ---------------------------------------------------------------------

/// No event-specific data beyond the header.
pub fn payload_empty() -> [u8; EVENT_PAYLOAD_SIZE] {
    [0u8; EVENT_PAYLOAD_SIZE]
}

/// `[0..2]` seat_index.
pub fn payload_seat(seat_index: u16) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload
}

/// `[0..2]` seat_index (`NO_SEAT` for market-level), `[2..10]` amount,
/// `[10..18]` resulting balance. Custody events (the mint is static per
/// market and already known from the market's own configuration, so it is
/// deliberately not repeated in every event).
pub fn payload_seat_amount(seat_index: u16, amount: u64, balance: u64) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..10].copy_from_slice(&amount.to_le_bytes());
    payload[10..18].copy_from_slice(&balance.to_le_bytes());
    payload
}

/// `[0..2]` seat_index, `[2..18]` order_key (u128), `[18]` side
/// (0=bid,1=ask), `[19..27]` price (i64), `[27..35]` quantity (u64).
#[allow(clippy::too_many_arguments)]
pub fn payload_order(
    seat_index: u16,
    order_key: u128,
    side: u8,
    price: i64,
    quantity: u64,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..18].copy_from_slice(&order_key.to_le_bytes());
    payload[18] = side;
    payload[19..27].copy_from_slice(&price.to_le_bytes());
    payload[27..35].copy_from_slice(&quantity.to_le_bytes());
    payload
}

/// `[0..4]` maker_seat, `[4..8]` taker_seat, `[8..16]` price (i64),
/// `[16..24]` quantity, `[24..32]` fill sequence (the `FillEvent` ring
/// slot's own sequence, distinct from the market-wide event sequence in
/// the header).
pub fn payload_fill(
    maker_seat: u32,
    taker_seat: u32,
    price: i64,
    quantity: u64,
    fill_sequence: u64,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..4].copy_from_slice(&maker_seat.to_le_bytes());
    payload[4..8].copy_from_slice(&taker_seat.to_le_bytes());
    payload[8..16].copy_from_slice(&price.to_le_bytes());
    payload[16..24].copy_from_slice(&quantity.to_le_bytes());
    payload[24..32].copy_from_slice(&fill_sequence.to_le_bytes());
    payload
}

/// `[0..2]` seat_index, `[2..18]` base_position (i128), `[18..34]`
/// quote_entry_value (i128).
pub fn payload_position(
    seat_index: u16,
    base_position: i128,
    quote_entry_value: i128,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..18].copy_from_slice(&base_position.to_le_bytes());
    payload[18..34].copy_from_slice(&quote_entry_value.to_le_bytes());
    payload
}

/// `[0..2]` seat_index (`NO_SEAT` for the market-wide accumulator update),
/// `[2..18]` funding accumulator (i128), `[18..34]` payment applied (i128,
/// zero for a pure accumulator update with no seat settlement).
pub fn payload_funding(
    seat_index: u16,
    accumulator: i128,
    payment: i128,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..18].copy_from_slice(&accumulator.to_le_bytes());
    payload[18..34].copy_from_slice(&payment.to_le_bytes());
    payload
}

/// `[0..2]` seat_index, `[2..10]` quantity, `[10..18]` price (i64).
pub fn payload_liquidation(seat_index: u16, quantity: u64, price: i64) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..10].copy_from_slice(&quantity.to_le_bytes());
    payload[10..18].copy_from_slice(&price.to_le_bytes());
    payload
}

/// `[0..8]` price (i64), `[8..10]` exponent (i16), `[10..18]` confidence
/// (i64), `[18..20]` session (i16, `-1` when not applicable).
pub fn payload_oracle(
    price: i64,
    exponent: i16,
    confidence: i64,
    session: i16,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..8].copy_from_slice(&price.to_le_bytes());
    payload[8..10].copy_from_slice(&exponent.to_le_bytes());
    payload[10..18].copy_from_slice(&confidence.to_le_bytes());
    payload[18..20].copy_from_slice(&session.to_le_bytes());
    payload
}

/// `[0..32]` validator/authority pubkey, `[32..40]` sequence.
pub fn payload_delegation(validator: &[u8; 32], sequence: u64) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..32].copy_from_slice(validator);
    payload[32..40].copy_from_slice(&sequence.to_le_bytes());
    payload
}

/// `[0..2]` seat_index, `[2..34]` session_signer pubkey, `[34..42]` nonce.
pub fn payload_session(
    seat_index: u16,
    session_signer: &[u8; 32],
    nonce: u64,
) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..34].copy_from_slice(session_signer);
    payload[34..42].copy_from_slice(&nonce.to_le_bytes());
    payload
}

/// `[0..32]` instrument_id.
pub fn payload_registry(instrument_id: &[u8; 32]) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..32].copy_from_slice(instrument_id);
    payload
}

/// `[0..8]` actual vault balance, `[8..16]` expected liability,
/// `[16]` reconciliation status (`ReconciliationStatus` as `u8`).
pub fn payload_reconciliation(actual: u64, expected: u64, status: u8) -> [u8; EVENT_PAYLOAD_SIZE] {
    let mut payload = [0u8; EVENT_PAYLOAD_SIZE];
    payload[0..8].copy_from_slice(&actual.to_le_bytes());
    payload[8..16].copy_from_slice(&expected.to_le_bytes());
    payload[16] = status;
    payload
}
