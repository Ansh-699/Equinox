/**
 * PATRICIA arena layout. Must match `book::Arena` and `book::InnerNode`/`LeafNode`.
 */
export const BID_ARENA_OFFSET = 512;
export const ASK_ARENA_OFFSET = 91_152;
export const ARENA_CAPACITY = 1024;
export const ARENA_SIZE = 90_640;
export const ARENA_NODES_OFFSET = 528; // version(4) + roots(8) + leaf_counts(8) + bump(4) + free(8) + reserved(496)
export const ANY_NODE_SIZE = 88;
export const TAG_INNER = 1;
export const TAG_LEAF = 2;
export const TAG_FREE = 3;

// InnerNode layout (packed(8)): tag(1)+pad(3)+prefix_len(4)+key(16)+children(8)+child_earliest_expiry(16)+reserved(40) = 88
export const INNER_CHILDREN_OFFSET = 24;
export const INNER_CHILD_EXPIRY_OFFSET = 32;

// LeafNode (packed(8)): tag(1)+side(1)+tif(1)+pad(1)+owner(4)+key(16)+quantity(8)+expires_at(8)+peg_limit(8)+client_order_id(8)+price_or_offset(8)+sequence(8)+flags(1)+reserved(15) = 88
export const LEAF_SIDE_OFFSET = 1;
export const LEAF_QUANTITY_OFFSET = 24;
export const LEAF_EXPIRES_AT_OFFSET = 32;
export const LEAF_PEG_LIMIT_OFFSET = 40;
export const LEAF_PRICE_OFFSET = 56;
export const LEAF_SEQUENCE_OFFSET = 64;

export const SIDE = { Bid: 0, Ask: 1 } as const;
export const TREE = { Fixed: 0, OraclePegged: 1 } as const;
