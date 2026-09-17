//! Planner-level self-trade-prevention coverage.
//!
//! `plan_limit_arenas` is the same planner production `place_order_core`
//! drives through the settlement scratch account, so these assert the exact
//! plan (fills, actions, virtual view) and the resulting book bytes without
//! needing a full account fixture. The handler-level consequences --
//! `SelfTradeAborted` surfacing as a program error, byte preservation, and
//! event-sequence accounting -- live in `account_settlement.rs`.

use stockstream::book::{
    plan_limit_arenas, Arena, MatchLimits, OrderInput, SelfTradeBehavior, Side, TimeInForce,
    TreeKind,
};

fn order(side: Side, tree: TreeKind, price: i64, sequence: u64) -> OrderInput {
    OrderInput {
        side,
        tree,
        owner: sequence as u32 + 1,
        price_or_offset: price,
        sequence,
        quantity: 10,
        expires_at: 0,
        peg_limit: if side == Side::Bid { i64::MAX } else { 1 },
        client_order_id: sequence,
        time_in_force: TimeInForce::GoodTilCancelled,
        post_only: false,
        self_trade_behavior: SelfTradeBehavior::AbortTransaction,
    }
}

fn limits() -> MatchLimits {
    MatchLimits {
        max_fills: 4,
        max_invalid_removals: 2,
        max_expired_removals: 2,
    }
}

fn insert(arena: &mut Arena, input: OrderInput) -> u32 {
    arena.insert(input.tree, input.leaf().unwrap()).unwrap()
}

#[test]
fn flags_bits_three_and_four_encode_the_self_trade_behavior() {
    assert_eq!(
        SelfTradeBehavior::from_u8(0),
        Some(SelfTradeBehavior::AbortTransaction)
    );
    assert_eq!(
        SelfTradeBehavior::from_u8(1),
        Some(SelfTradeBehavior::CancelProvide)
    );
    assert_eq!(
        SelfTradeBehavior::from_u8(2),
        Some(SelfTradeBehavior::DecrementTake)
    );
    // The fourth encoding is deliberately unused: a client sending it is
    // rejected outright rather than silently mapped to a default.
    assert_eq!(SelfTradeBehavior::from_u8(3), None);

    for (value, expected) in [
        (0u8, SelfTradeBehavior::AbortTransaction),
        (1, SelfTradeBehavior::CancelProvide),
        (2, SelfTradeBehavior::DecrementTake),
    ] {
        let flags = value << 3;
        assert_eq!(
            SelfTradeBehavior::from_u8((flags >> 3) & 0b11),
            Some(expected)
        );
    }

    // Bits 0-2 remain the pre-existing post-only / IOC / reduce-only flags,
    // so the two encodings never overlap.
    assert_eq!((0b0000_0111u8 >> 3) & 0b11, 0);
    // Bits 5-7 are outside the allowed mask and are still rejected wholesale
    // by the handler's `order.flags & !31 != 0` check.
    assert_eq!(0b0010_0000u8 & !31u8, 0b0010_0000);
}

#[test]
fn self_trade_abort_flags_the_plan_and_applies_nothing() {
    let bids = Arena::new();
    let mut asks = Arena::new();
    let maker = order(Side::Ask, TreeKind::Fixed, 100, 1);
    insert(&mut asks, maker);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 2);
    taker.owner = maker.owner;
    taker.self_trade_behavior = SelfTradeBehavior::AbortTransaction;

    let plan = plan_limit_arenas(&bids, &asks, taker, Some(100), 1, limits()).unwrap();

    assert!(plan.self_trade_aborted);
    assert_eq!(plan.fill_count, 0, "abort must create no fill");
    assert_eq!(plan.action_count, 0, "abort must plan no book change");
    assert_eq!(plan.self_cancelled, 0);
    assert_eq!(
        plan.remaining, taker.quantity,
        "abort must not decrement the taker either"
    );
}

#[test]
fn self_trade_cancel_provide_removes_the_own_maker_and_fills_the_next_trader() {
    let bids = Arena::new();
    let mut asks = Arena::new();
    let own = order(Side::Ask, TreeKind::Fixed, 100, 1);
    let own_handle = insert(&mut asks, own);
    let other = order(Side::Ask, TreeKind::Fixed, 100, 2);
    let other_handle = insert(&mut asks, other);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 3);
    taker.owner = own.owner;
    taker.self_trade_behavior = SelfTradeBehavior::CancelProvide;

    let plan = plan_limit_arenas(&bids, &asks, taker, Some(100), 1, limits()).unwrap();

    assert!(!plan.self_trade_aborted);
    assert_eq!(plan.self_cancelled, 1);
    assert_eq!(plan.fill_count, 1);
    assert_eq!(
        plan.fills[0].maker, other.owner,
        "must fill the other trader"
    );
    assert_eq!(plan.fills[0].maker_handle, other_handle);
    assert_eq!(plan.remaining, 0);
    assert_eq!(plan.action_count, 2);
    assert_eq!(plan.actions[0].handle, own_handle);
    assert!(plan.actions[0].remove, "the own order is removed");
    assert_eq!(plan.actions[1].handle, other_handle);
    assert!(plan.actions[1].remove);
}

#[test]
fn self_trade_decrement_take_leaves_the_maker_untouched() {
    let bids = Arena::new();
    let mut asks = Arena::new();
    let maker = order(Side::Ask, TreeKind::Fixed, 100, 1);
    let maker_handle = insert(&mut asks, maker);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 2);
    taker.owner = maker.owner;
    taker.self_trade_behavior = SelfTradeBehavior::DecrementTake;
    taker.quantity = 4;

    let plan = plan_limit_arenas(&bids, &asks, taker, Some(100), 1, limits()).unwrap();

    assert!(!plan.self_trade_aborted);
    assert_eq!(plan.self_cancelled, 1);
    assert_eq!(plan.fill_count, 0, "no fill for the prevented self-cross");
    assert_eq!(plan.remaining, 0, "4 requested, 4 decremented against own");
    assert_eq!(plan.action_count, 1);
    assert!(
        plan.actions[0].phantom,
        "the maker must be skipped, not changed"
    );
    assert!(!plan.actions[0].remove);
    assert_eq!(plan.actions[0].handle, maker_handle);
    assert_eq!(
        plan.actions[0].new_quantity, maker.quantity,
        "the resting maker keeps its full quantity"
    );
}

#[test]
fn self_trade_decrement_take_continues_matching_the_next_trader() {
    let bids = Arena::new();
    let mut asks = Arena::new();
    let mut own = order(Side::Ask, TreeKind::Fixed, 100, 1);
    own.quantity = 2;
    insert(&mut asks, own);
    let other = order(Side::Ask, TreeKind::Fixed, 101, 2);
    let other_handle = insert(&mut asks, other);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 3);
    taker.owner = own.owner;
    taker.self_trade_behavior = SelfTradeBehavior::DecrementTake;
    taker.quantity = 5;

    let plan = plan_limit_arenas(&bids, &asks, taker, Some(100), 1, limits()).unwrap();

    assert_eq!(plan.self_cancelled, 1);
    assert_eq!(
        plan.fill_count, 1,
        "matching must continue past the own order"
    );
    assert_eq!(plan.fills[0].maker, other.owner);
    assert_eq!(plan.fills[0].quantity, 3, "5 requested minus 2 decremented");
    assert_eq!(plan.remaining, 0);
    assert_eq!(plan.action_count, 2);
    assert!(plan.actions[0].phantom);
    assert!(!plan.actions[0].remove);
    assert_eq!(plan.actions[1].handle, other_handle);
}

#[test]
fn post_only_rejection_takes_precedence_over_self_trade_handling() {
    let bids = Arena::new();
    let mut asks = Arena::new();
    let maker = order(Side::Ask, TreeKind::Fixed, 100, 1);
    insert(&mut asks, maker);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 2);
    taker.owner = maker.owner;
    taker.post_only = true;
    // `CancelProvide` would otherwise remove the trader's own resting order
    // and then execute against the next trader -- neither may happen for a
    // post-only order that would have crossed at all.
    taker.self_trade_behavior = SelfTradeBehavior::CancelProvide;

    let plan = plan_limit_arenas(&bids, &asks, taker, Some(100), 1, limits()).unwrap();

    assert!(plan.post_only_rejected, "post-only must reject first");
    assert!(!plan.self_trade_aborted);
    assert_eq!(plan.self_cancelled, 0, "no STP action may be planned");
    assert_eq!(plan.action_count, 0, "the book must be untouched");
    assert_eq!(plan.fill_count, 0);
}
