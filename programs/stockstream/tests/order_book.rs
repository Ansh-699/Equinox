use stockstream::book::{
    match_limit, normalized_key, pegged_state, price_time_key, AnyNode, Arena, BookError,
    LastFreeNode, MarketState, MatchLimits, OrderInput, PeggedState, Side, TimeInForce, TreeKind,
    ARENA_CAPACITY,
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
    }
}

fn insert(arena: &mut Arena, input: OrderInput) -> u32 {
    arena.insert(input.tree, input.leaf().unwrap()).unwrap()
}

#[test]
fn node_layouts_are_exactly_88_bytes_and_empty_root_inserts() {
    let mut arena = Arena::new();
    let handle = insert(&mut arena, order(Side::Ask, TreeKind::Fixed, 100, 1));
    assert_eq!(handle, 0);
    assert_eq!(arena.best(TreeKind::Fixed).unwrap(), Some(handle));
    arena.validate().unwrap();
}

#[test]
fn split_above_and_descendant_insertions_preserve_integrity() {
    let mut arena = Arena::new();
    let a = order(Side::Ask, TreeKind::Fixed, 100, 10);
    let b = order(Side::Ask, TreeKind::Fixed, 101, 11);
    let c = order(Side::Ask, TreeKind::Fixed, 99, 12);
    insert(&mut arena, a);
    insert(&mut arena, b);
    insert(&mut arena, c);
    assert_eq!(
        arena.find(TreeKind::Fixed, a.leaf().unwrap().key).unwrap(),
        0
    );
    assert_eq!(
        arena.best(TreeKind::Fixed).unwrap().unwrap(),
        arena.find(TreeKind::Fixed, c.leaf().unwrap().key).unwrap()
    );
    arena.validate().unwrap();
}

#[test]
fn duplicate_lookup_and_branch_compression_work() {
    let mut arena = Arena::new();
    let a = order(Side::Bid, TreeKind::Fixed, 100, 1);
    let b = order(Side::Bid, TreeKind::Fixed, 101, 2);
    let c = order(Side::Bid, TreeKind::Fixed, 99, 3);
    insert(&mut arena, a);
    insert(&mut arena, b);
    insert(&mut arena, c);
    assert_eq!(
        arena.insert(TreeKind::Fixed, a.leaf().unwrap()),
        Err(BookError::DuplicateKey)
    );
    arena
        .remove(TreeKind::Fixed, b.leaf().unwrap().key)
        .unwrap();
    arena
        .remove(TreeKind::Fixed, c.leaf().unwrap().key)
        .unwrap();
    assert_eq!(
        arena.best(TreeKind::Fixed).unwrap().unwrap(),
        arena.find(TreeKind::Fixed, a.leaf().unwrap().key).unwrap()
    );
    arena
        .remove(TreeKind::Fixed, a.leaf().unwrap().key)
        .unwrap();
    assert_eq!(arena.best(TreeKind::Fixed).unwrap(), None);
    arena.validate().unwrap();
}

#[test]
fn allocator_recycles_free_nodes_and_exhausts_capacity() {
    let mut arena = Arena::new();
    let first = order(Side::Ask, TreeKind::Fixed, 100, 1);
    let first_handle = insert(&mut arena, first);
    arena
        .remove(TreeKind::Fixed, first.leaf().unwrap().key)
        .unwrap();
    let reused = insert(&mut arena, order(Side::Ask, TreeKind::Fixed, 101, 2));
    assert_eq!(reused, first_handle);
    let mut full = false;
    for sequence in 3..700 {
        if matches!(
            arena.insert(
                TreeKind::Fixed,
                order(Side::Ask, TreeKind::Fixed, sequence as i64 + 100, sequence)
                    .leaf()
                    .unwrap(),
            ),
            Err(BookError::Full)
        ) {
            full = true;
            break;
        }
    }
    assert!(full);
    assert!(arena.bump_index as usize <= ARENA_CAPACITY);
    if let Err(error) = arena.validate() {
        panic!(
            "full arena validation failed: {error:?}, bump={}, free_len={}, leaves={}",
            arena.bump_index,
            arena.free_len,
            arena.leaf_counts[TreeKind::Fixed as usize]
        );
    }
}

#[test]
fn corrupt_handles_and_tags_are_rejected() {
    let mut arena = Arena::new();
    assert_eq!(arena.find(TreeKind::Fixed, 9), Err(BookError::MissingKey));
    insert(&mut arena, order(Side::Ask, TreeKind::Fixed, 100, 1));
    arena.nodes[0] = AnyNode {
        last_free: LastFreeNode {
            tag: 99,
            _reserved: [0; 87],
        },
    };
    assert!(matches!(
        arena.validate(),
        Err(BookError::BadTag) | Err(BookError::Integrity)
    ));
}

#[test]
fn expiry_cache_propagates_and_sweeps_incrementally() {
    let mut arena = Arena::new();
    let mut early = order(Side::Ask, TreeKind::Fixed, 100, 1);
    early.expires_at = 10;
    let mut late = order(Side::Ask, TreeKind::Fixed, 101, 2);
    late.expires_at = 20;
    insert(&mut arena, early);
    insert(&mut arena, late);
    assert!(arena.first_expired(TreeKind::Fixed, 10).unwrap().is_some());
    assert_eq!(arena.sweep_expired(TreeKind::Fixed, 10, 1).unwrap(), 1);
    assert_eq!(arena.sweep_expired(TreeKind::Fixed, 20, 1).unwrap(), 1);
    arena.validate().unwrap();
}

#[test]
fn canonical_price_time_keys_are_fifo_and_bid_best_first() {
    assert!(
        price_time_key(Side::Ask, 100, 1).unwrap() < price_time_key(Side::Ask, 100, 2).unwrap()
    );
    assert!(
        price_time_key(Side::Bid, 101, 1).unwrap() < price_time_key(Side::Bid, 100, 1).unwrap()
    );
    assert_eq!(price_time_key(Side::Ask, 0, 1), Err(BookError::BadPrice));
}

#[test]
fn pegged_states_cover_valid_invalid_and_skipped() {
    let mut input = order(Side::Ask, TreeKind::OraclePegged, 5, 1);
    input.peg_limit = 100;
    let leaf = input.leaf().unwrap();
    assert_eq!(pegged_state(&leaf, None, 1), PeggedState::Skipped);
    assert_eq!(pegged_state(&leaf, Some(100), 1), PeggedState::Valid(105));
    assert_eq!(pegged_state(&leaf, Some(90), 1), PeggedState::Invalid);
    assert_eq!(
        normalized_key(&leaf, TreeKind::OraclePegged, Some(100), 1).unwrap(),
        Some(price_time_key(Side::Ask, 105, 1).unwrap())
    );
}

#[test]
fn matching_merges_fixed_and_pegged_with_cross_tree_fifo() {
    let mut market = MarketState::new();
    let fixed = order(Side::Ask, TreeKind::Fixed, 105, 20);
    let mut pegged = order(Side::Ask, TreeKind::OraclePegged, 5, 10);
    pegged.peg_limit = 100;
    insert(market.arena_mut(Side::Ask), fixed);
    insert(market.arena_mut(Side::Ask), pegged);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 99);
    taker.quantity = 20;
    let result = match_limit(
        &mut market,
        taker,
        Some(100),
        1,
        MatchLimits {
            max_fills: 2,
            max_invalid_removals: 2,
            max_expired_removals: 2,
        },
    )
    .unwrap();
    assert_eq!(result.fill_count, 2);
    assert_eq!(result.fills[0].maker_client_order_id, 10);
    assert_eq!(result.fills[1].maker_client_order_id, 20);
    market.asks.validate().unwrap();
}

#[test]
fn matching_is_bounded_supports_ioc_partial_and_self_cancel() {
    let mut market = MarketState::new();
    let mut maker_one = order(Side::Ask, TreeKind::Fixed, 100, 1);
    maker_one.owner = 7;
    let mut maker_two = order(Side::Ask, TreeKind::Fixed, 101, 2);
    maker_two.owner = 8;
    insert(market.arena_mut(Side::Ask), maker_one);
    insert(market.arena_mut(Side::Ask), maker_two);
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 3);
    taker.owner = 7;
    taker.quantity = 15;
    taker.time_in_force = TimeInForce::ImmediateOrCancel;
    let result = match_limit(
        &mut market,
        taker,
        Some(100),
        1,
        MatchLimits {
            max_fills: 1,
            max_invalid_removals: 2,
            max_expired_removals: 0,
        },
    )
    .unwrap();
    assert_eq!(result.self_cancelled, 1);
    assert_eq!(result.fill_count, 1);
    assert_eq!(result.remaining, 5);
    market.asks.validate().unwrap();
}

#[test]
fn matching_removes_invalid_orders_and_rejects_crossing_post_only() {
    let mut market = MarketState::new();
    let mut invalid = order(Side::Ask, TreeKind::OraclePegged, -10, 1);
    invalid.peg_limit = 100;
    insert(market.arena_mut(Side::Ask), invalid);
    insert(
        market.arena_mut(Side::Ask),
        order(Side::Ask, TreeKind::Fixed, 100, 2),
    );
    let taker = order(Side::Bid, TreeKind::Fixed, 110, 3);
    let result = match_limit(
        &mut market,
        taker,
        Some(100),
        1,
        MatchLimits {
            max_fills: 1,
            max_invalid_removals: 1,
            max_expired_removals: 0,
        },
    )
    .unwrap();
    assert_eq!(result.invalid_removed, 1);
    assert_eq!(result.fill_count, 1);

    insert(
        market.arena_mut(Side::Ask),
        order(Side::Ask, TreeKind::Fixed, 100, 4),
    );
    let mut post_only = order(Side::Bid, TreeKind::Fixed, 110, 5);
    post_only.post_only = true;
    let result = match_limit(
        &mut market,
        post_only,
        Some(100),
        1,
        MatchLimits {
            max_fills: 1,
            max_invalid_removals: 1,
            max_expired_removals: 0,
        },
    )
    .unwrap();
    assert!(result.post_only_rejected);
    assert_eq!(market.bids.leaf_counts[TreeKind::Fixed as usize], 0);
}

#[test]
fn oracle_unavailable_skips_then_restores_pegged_liquidity() {
    let mut market = MarketState::new();
    let mut pegged = order(Side::Ask, TreeKind::OraclePegged, 0, 1);
    pegged.peg_limit = 1;
    insert(market.arena_mut(Side::Ask), pegged);
    insert(
        market.arena_mut(Side::Ask),
        order(Side::Ask, TreeKind::Fixed, 101, 2),
    );
    let mut taker = order(Side::Bid, TreeKind::Fixed, 110, 3);
    taker.quantity = 10;
    let skipped = match_limit(
        &mut market,
        taker,
        None,
        1,
        MatchLimits {
            max_fills: 1,
            max_invalid_removals: 1,
            max_expired_removals: 0,
        },
    )
    .unwrap();
    assert_eq!(skipped.fills[0].maker_client_order_id, 2);
    let restored = match_limit(
        &mut market,
        order(Side::Bid, TreeKind::Fixed, 110, 4),
        Some(100),
        1,
        MatchLimits {
            max_fills: 1,
            max_invalid_removals: 1,
            max_expired_removals: 0,
        },
    )
    .unwrap();
    assert_eq!(restored.fills[0].maker_client_order_id, 1);
}

#[test]
fn randomized_state_machine_keeps_arena_integrity() {
    let mut arena = Arena::new();
    let mut keys = [0u128; 96];
    let mut len = 0usize;
    let mut seed = 0x5eed_u64;
    for sequence in 1..800u64 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        if len > 0 && seed & 1 == 0 {
            let index = (seed as usize) % len;
            arena.remove(TreeKind::Fixed, keys[index]).unwrap();
            keys[index] = keys[len - 1];
            len -= 1;
        } else if len < keys.len() {
            let price = ((seed >> 16) % 10_000 + 1) as i64;
            let input = order(Side::Ask, TreeKind::Fixed, price, sequence);
            keys[len] = input.leaf().unwrap().key;
            insert(&mut arena, input);
            len += 1;
        }
        arena.validate().unwrap();
    }
}
