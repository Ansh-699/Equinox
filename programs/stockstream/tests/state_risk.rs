use stockstream::{
    risk::{apply_fill, available_margin, equity, is_liquidatable, settle_funding, unrealized_pnl},
    state::{
        MarketStateHeader, SeatError, TraderSeat, TraderSeatRegion, MARKET_ACCOUNT_SIZE,
        MARKET_HEADER_SIZE, TRADER_SEAT_REGION_SIZE,
    },
};

#[test]
fn market_layout_is_versioned_and_regions_are_exact() {
    let header = MarketStateHeader::empty();
    assert_eq!(
        core::mem::size_of::<MarketStateHeader>(),
        MARKET_HEADER_SIZE
    );
    assert_eq!(header.bid_arena_offset as usize, MARKET_HEADER_SIZE);
    assert!(header.validate(MARKET_ACCOUNT_SIZE).is_ok());
    assert_eq!(TRADER_SEAT_REGION_SIZE, 128 * 256);
}

#[test]
fn trader_seat_lifecycle_rejects_duplicates_full_and_non_empty_close() {
    let mut seats = TraderSeatRegion::empty();
    let trader = [7u8; 32];
    assert_eq!(seats.create(trader), Ok(0));
    assert_eq!(seats.create(trader), Err(SeatError::Duplicate));
    seats.seats[0].available_collateral = 100;
    assert_eq!(seats.close(0), Ok(()));
    let mut i = 0;
    while i < 128 {
        assert!(seats.create([i as u8; 32]).is_ok());
        i += 1;
    }
    assert_eq!(seats.create([250; 32]), Err(SeatError::Full));
}

#[test]
fn long_reduction_and_flip_calculate_weighted_pnl() {
    let mut seat = TraderSeat::empty();
    apply_fill(&mut seat, 10, 100, 0).unwrap();
    apply_fill(&mut seat, -4, 110, 0).unwrap();
    let position = seat.base_position;
    let realized = seat.realized_pnl;
    assert_eq!(position, 6);
    assert_eq!(realized, 40);
    apply_fill(&mut seat, -10, 90, 0).unwrap();
    let flipped_position = seat.base_position;
    let flipped_entry = seat.quote_entry_value;
    assert_eq!(flipped_position, -4);
    assert_eq!(flipped_entry, -360);
    assert_eq!(unrealized_pnl(&seat, 90).unwrap(), 0);
}

#[test]
fn short_reduction_and_fees_are_symmetric() {
    let mut seat = TraderSeat::empty();
    apply_fill(&mut seat, -5, 100, 100).unwrap();
    apply_fill(&mut seat, 2, 90, 100).unwrap();
    let position = seat.base_position;
    assert_eq!(position, -3);
    assert!(seat.realized_pnl > 0);
}

#[test]
fn repeated_partial_closes_preserve_fractional_entry_value() {
    let mut seat = TraderSeat::empty();
    apply_fill(&mut seat, 3, 100, 0).unwrap();
    apply_fill(&mut seat, 1, 101, 0).unwrap();
    apply_fill(&mut seat, -1, 102, 0).unwrap();
    let position = seat.base_position;
    let entry = seat.quote_entry_value;
    let realized = seat.realized_pnl;
    assert_eq!(position, 3);
    assert_eq!(entry, 301);
    assert_eq!(realized, 2);
    apply_fill(&mut seat, -3, 102, 0).unwrap();
    let position = seat.base_position;
    let entry = seat.quote_entry_value;
    let realized = seat.realized_pnl;
    assert_eq!(position, 0);
    assert_eq!(entry, 0);
    assert_eq!(realized, 7);
}

#[test]
fn funding_equity_margin_and_liquidation_are_checked() {
    let mut seat = TraderSeat::empty();
    seat.available_collateral = 100;
    apply_fill(&mut seat, 1, 100, 0).unwrap();
    settle_funding(&mut seat, 10_000).unwrap();
    let funding = seat.last_funding_accumulator;
    assert_eq!(funding, 10_000);
    assert!(equity(&seat, 110).unwrap() > 100);
    assert!(available_margin(&seat, 110, 2_000).unwrap() < 100);
    seat.available_collateral = 0;
    assert!(is_liquidatable(&seat, 100, 1_000).unwrap());
}

#[test]
fn overflow_and_invalid_prices_are_rejected() {
    let mut seat = TraderSeat::empty();
    assert!(apply_fill(&mut seat, i128::MAX, i128::MAX, 0).is_err());
    assert!(apply_fill(&mut seat, 1, 0, 0).is_err());
}
