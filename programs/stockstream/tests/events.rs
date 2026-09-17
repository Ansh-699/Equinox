//! Priority 7: golden vectors for the versioned binary StockStream event
//! ABI (`events.rs`). `sol_log_data` is a no-op off the SBF target (see
//! `docs/magicblock.md`), so these test `encode_event`/the payload builders
//! directly -- the exact bytes that would be passed to the syscall -- not
//! that the syscall fires.

use stockstream::events::{
    encode_event, payload_delegation, payload_empty, payload_fill, payload_funding,
    payload_liquidation, payload_oracle, payload_order, payload_position, payload_reconciliation,
    payload_registry, payload_seat, payload_seat_amount, payload_session, EventKind,
    EVENT_ABI_VERSION, EVENT_HEADER_SIZE, EVENT_PAYLOAD_SIZE, EVENT_SIZE, NO_SEAT,
};

const MARKET: [u8; 32] = [7u8; 32];

#[test]
fn header_layout_is_exact_and_stable() {
    assert_eq!(EVENT_HEADER_SIZE, 52);
    assert_eq!(EVENT_PAYLOAD_SIZE, 48);
    assert_eq!(EVENT_SIZE, 100);
    let bytes = encode_event(
        EventKind::MarketPaused,
        &MARKET,
        9,
        1_700_000_000,
        &payload_empty(),
    );
    assert_eq!(bytes.len(), EVENT_SIZE);
    // discriminator (u16 LE)
    assert_eq!(
        u16::from_le_bytes([bytes[0], bytes[1]]),
        EventKind::MarketPaused as u16
    );
    // abi_version
    assert_eq!(bytes[2], EVENT_ABI_VERSION);
    // reserved
    assert_eq!(bytes[3], 0);
    // sequence (u64 LE) at [4..12]
    assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 9);
    // market at [12..44]
    assert_eq!(&bytes[12..44], &MARKET);
    // timestamp (u64 LE) at [44..52]
    assert_eq!(
        u64::from_le_bytes(bytes[44..52].try_into().unwrap()),
        1_700_000_000
    );
}

#[test]
fn every_event_kind_has_a_stable_unique_discriminator() {
    use EventKind::*;
    let kinds = [
        ExchangeInitialized as u16,
        ExchangeConfigUpdated as u16,
        StockInstrumentRegistered as u16,
        StockInstrumentUpdated as u16,
        StockInstrumentSuspended as u16,
        PerpMarketCreated as u16,
        MarketRiskUpdated as u16,
        MarketPaused as u16,
        MarketResumed as u16,
        MarketCloseOnly as u16,
        CorporateActionEntered as u16,
        CorporateActionResolved as u16,
        MarketClosed as u16,
        TraderSeatCreated as u16,
        TraderSeatClosed as u16,
        OrderPlaced as u16,
        OrderPartiallyFilled as u16,
        OrderFilled as u16,
        OrderCancelled as u16,
        CancelAllProgress as u16,
        OrderReplaced as u16,
        OrderExpired as u16,
        InvalidOrderRemoved as u16,
        SelfTradePrevented as u16,
        PositionChanged as u16,
        MarginChanged as u16,
        FundingAccumulatorUpdated as u16,
        FundingSettled as u16,
        LiquidationStarted as u16,
        PositionLiquidated as u16,
        BankruptcyRecorded as u16,
        InsuranceApplied as u16,
        VaultInitialized as u16,
        CollateralDeposited as u16,
        CollateralWithdrawn as u16,
        ProtocolFeesChanged as u16,
        InsuranceFundChanged as u16,
        BadDebtRecorded as u16,
        BadDebtResolved as u16,
        VaultSurplusDetected as u16,
        VaultDeficitDetected as u16,
        VaultReconciled as u16,
        OracleUpdated as u16,
        OracleRejected as u16,
        MarketSessionChanged as u16,
        TradingStatusChanged as u16,
        OracleStale as u16,
        OracleRecovered as u16,
        DelegationRequested as u16,
        MarketDelegated as u16,
        CommitRequested as u16,
        CommitSequenceChanged as u16,
        UndelegationRequested as u16,
        RestorationPending as u16,
        MarketRestored as u16,
        DelegationErrorState as u16,
        TradingSessionAuthorized as u16,
        TradingSessionLimitsUpdated as u16,
        TradingSessionActionConsumed as u16,
        TradingSessionRevoked as u16,
        TradingSessionClosed as u16,
    ];
    let mut sorted = kinds.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        kinds.len(),
        "every EventKind discriminator must be unique"
    );
    assert_eq!(
        kinds.len(),
        61,
        "expected exactly 61 event kinds from the Priority 7 spec"
    );
}

#[test]
fn seat_amount_payload_layout_and_no_seat_sentinel() {
    let payload = payload_seat_amount(3, 1_000, 4_000);
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 3);
    assert_eq!(
        u64::from_le_bytes(payload[2..10].try_into().unwrap()),
        1_000
    );
    assert_eq!(
        u64::from_le_bytes(payload[10..18].try_into().unwrap()),
        4_000
    );
    assert!(payload[18..].iter().all(|&b| b == 0));

    let market_level = payload_seat_amount(NO_SEAT, 0, 0);
    assert_eq!(
        u16::from_le_bytes(market_level[0..2].try_into().unwrap()),
        NO_SEAT
    );
}

#[test]
fn order_payload_layout() {
    let payload = payload_order(
        5,
        0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00u128,
        1,
        -100,
        250,
    );
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 5);
    assert_eq!(
        u128::from_le_bytes(payload[2..18].try_into().unwrap()),
        0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00u128
    );
    assert_eq!(payload[18], 1);
    assert_eq!(
        i64::from_le_bytes(payload[19..27].try_into().unwrap()),
        -100
    );
    assert_eq!(u64::from_le_bytes(payload[27..35].try_into().unwrap()), 250);
    assert!(payload[35..].iter().all(|&b| b == 0));
}

#[test]
fn fill_payload_layout() {
    let payload = payload_fill(2, 9, 12_345, 77, 4);
    assert_eq!(u32::from_le_bytes(payload[0..4].try_into().unwrap()), 2);
    assert_eq!(u32::from_le_bytes(payload[4..8].try_into().unwrap()), 9);
    assert_eq!(
        i64::from_le_bytes(payload[8..16].try_into().unwrap()),
        12_345
    );
    assert_eq!(u64::from_le_bytes(payload[16..24].try_into().unwrap()), 77);
    assert_eq!(u64::from_le_bytes(payload[24..32].try_into().unwrap()), 4);
}

#[test]
fn position_payload_layout_handles_negative_positions() {
    let payload = payload_position(1, -500, -12_000);
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 1);
    assert_eq!(
        i128::from_le_bytes(payload[2..18].try_into().unwrap()),
        -500
    );
    assert_eq!(
        i128::from_le_bytes(payload[18..34].try_into().unwrap()),
        -12_000
    );
}

#[test]
fn funding_payload_layout() {
    let payload = payload_funding(NO_SEAT, 1_000_000, 0);
    assert_eq!(
        u16::from_le_bytes(payload[0..2].try_into().unwrap()),
        NO_SEAT
    );
    assert_eq!(
        i128::from_le_bytes(payload[2..18].try_into().unwrap()),
        1_000_000
    );
    assert_eq!(i128::from_le_bytes(payload[18..34].try_into().unwrap()), 0);
}

#[test]
fn liquidation_payload_layout() {
    let payload = payload_liquidation(4, 50, 9_900);
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 4);
    assert_eq!(u64::from_le_bytes(payload[2..10].try_into().unwrap()), 50);
    assert_eq!(
        i64::from_le_bytes(payload[10..18].try_into().unwrap()),
        9_900
    );
}

#[test]
fn oracle_payload_layout() {
    let payload = payload_oracle(1_234_500, -2, 100, 0);
    assert_eq!(
        i64::from_le_bytes(payload[0..8].try_into().unwrap()),
        1_234_500
    );
    assert_eq!(i16::from_le_bytes(payload[8..10].try_into().unwrap()), -2);
    assert_eq!(i64::from_le_bytes(payload[10..18].try_into().unwrap()), 100);
    assert_eq!(i16::from_le_bytes(payload[18..20].try_into().unwrap()), 0);
}

#[test]
fn delegation_payload_layout() {
    let validator = [9u8; 32];
    let payload = payload_delegation(&validator, 42);
    assert_eq!(&payload[0..32], &validator);
    assert_eq!(u64::from_le_bytes(payload[32..40].try_into().unwrap()), 42);
}

#[test]
fn session_payload_layout() {
    let signer = [3u8; 32];
    let payload = payload_session(6, &signer, 100);
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 6);
    assert_eq!(&payload[2..34], &signer);
    assert_eq!(u64::from_le_bytes(payload[34..42].try_into().unwrap()), 100);
}

#[test]
fn registry_payload_layout() {
    let instrument = [4u8; 32];
    let payload = payload_registry(&instrument);
    assert_eq!(&payload[0..32], &instrument);
}

#[test]
fn reconciliation_payload_layout() {
    let payload = payload_reconciliation(9_500, 10_000, 2);
    assert_eq!(u64::from_le_bytes(payload[0..8].try_into().unwrap()), 9_500);
    assert_eq!(
        u64::from_le_bytes(payload[8..16].try_into().unwrap()),
        10_000
    );
    assert_eq!(payload[16], 2);
}

#[test]
fn seat_payload_layout() {
    let payload = payload_seat(11);
    assert_eq!(u16::from_le_bytes(payload[0..2].try_into().unwrap()), 11);
    assert!(payload[2..].iter().all(|&b| b == 0));
}

#[test]
fn sequence_is_carried_exactly_and_distinguishes_events() {
    let a = encode_event(EventKind::OrderPlaced, &MARKET, 1, 0, &payload_empty());
    let b = encode_event(EventKind::OrderPlaced, &MARKET, 2, 0, &payload_empty());
    assert_ne!(a, b);
    assert_eq!(u64::from_le_bytes(a[4..12].try_into().unwrap()), 1);
    assert_eq!(u64::from_le_bytes(b[4..12].try_into().unwrap()), 2);
}

#[test]
fn events_for_different_markets_are_distinguishable() {
    let market_a = [1u8; 32];
    let market_b = [2u8; 32];
    let a = encode_event(EventKind::MarketPaused, &market_a, 1, 0, &payload_empty());
    let b = encode_event(EventKind::MarketPaused, &market_b, 1, 0, &payload_empty());
    assert_ne!(&a[12..44], &b[12..44]);
}

/// Golden vectors for the discriminators newly wired into production
/// handlers this session (`handlers.rs`/`magicblock.rs`): each of these
/// previously existed only as an `EventKind` variant with no real emission
/// site. Confirms the exact encoded bytes for a full fill vs. a partial
/// fill (sharing the same `payload_fill` shape but a different
/// discriminator), and for the newly-wired session/liquidation/MagicBlock
/// kinds.
#[test]
fn newly_wired_order_and_fill_discriminators_encode_correctly() {
    let full = encode_event(
        EventKind::OrderFilled,
        &MARKET,
        10,
        0,
        &payload_fill(1, 2, 100, 5, 10),
    );
    assert_eq!(
        u16::from_le_bytes(full[0..2].try_into().unwrap()),
        EventKind::OrderFilled as u16
    );
    let partial = encode_event(
        EventKind::OrderPartiallyFilled,
        &MARKET,
        11,
        0,
        &payload_fill(1, 2, 100, 3, 11),
    );
    assert_eq!(
        u16::from_le_bytes(partial[0..2].try_into().unwrap()),
        EventKind::OrderPartiallyFilled as u16
    );
    assert_ne!(full[0..2], partial[0..2]);
}

#[test]
fn newly_wired_session_liquidation_and_magicblock_discriminators_encode_correctly() {
    use EventKind::*;
    let cases = [
        (CancelAllProgress, payload_seat_amount(3, 2, 0)),
        (OrderReplaced, payload_order(1, 42, 0, 100, 5)),
        (
            TradingSessionActionConsumed,
            payload_session(2, &[9u8; 32], 7),
        ),
        (LiquidationStarted, payload_liquidation(4, 50, 100)),
        (PositionChanged, payload_position(4, -50, -5_000)),
        (MarginChanged, payload_seat_amount(4, 25, 0)),
        (FundingSettled, payload_funding(4, 1_000, -20)),
        (InvalidOrderRemoved, payload_seat_amount(NO_SEAT, 2, 0)),
        (OrderExpired, payload_seat_amount(NO_SEAT, 1, 0)),
        (DelegationRequested, payload_delegation(&[5u8; 32], 1)),
        (CommitSequenceChanged, payload_delegation(&[5u8; 32], 2)),
        (RestorationPending, payload_delegation(&[5u8; 32], 3)),
        (MarketClosed, payload_empty()),
        (CorporateActionResolved, payload_empty()),
    ];
    let mut discriminators = std::collections::HashSet::new();
    for (kind, payload) in cases {
        let bytes = encode_event(kind, &MARKET, 1, 0, &payload);
        let discriminator = u16::from_le_bytes(bytes[0..2].try_into().unwrap());
        assert_eq!(discriminator, kind as u16);
        assert_eq!(&bytes[52..], &payload[..]);
        assert!(
            discriminators.insert(discriminator),
            "duplicate discriminator in golden vector case list"
        );
    }
}
