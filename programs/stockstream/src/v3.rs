//! Version-three, MagicBlock-committable market account layout.
//!
//! V2 deliberately remains supported for the already-delegated Devnet market.
//! V3 never reinterprets a V2 account: every V3 PDA is separately derived
//! from the V3 core address and has an explicit discriminator/version.
//!
//! The MagicBlock committor's buffered delivery uses a `u16` state length.
//! `65_535` is therefore the largest representable account.  We deliberately
//! keep all pages at 24,640 bytes: that is also comfortably below the
//! vendored committor's exercised 50,000-byte buffered commit path.

use core::mem::size_of;

use pinocchio::Address;

pub const V3_LAYOUT_VERSION: u16 = 3;
pub const V3_COMMIT_ACCOUNT_HARD_MAX: usize = u16::MAX as usize;
pub const V3_COMMIT_ACCOUNT_SAFE_MAX: usize = 50_000;
pub const V3_PAGE_ACCOUNT_SIZE: usize = 24_640;

pub const V3_MARKET_CORE_SEED: &[u8] = b"market-v3";
pub const V3_BOOK_PAGE_SEED: &[u8] = b"book-page-v3";
pub const V3_SEAT_SHARD_SEED: &[u8] = b"seat-shard-v3";
pub const V3_EVENT_SHARD_SEED: &[u8] = b"event-shard-v3";

pub const V3_MARKET_CORE_DISCRIMINATOR: [u8; 8] = *b"STKMK003";
pub const V3_BOOK_PAGE_DISCRIMINATOR: [u8; 8] = *b"STKBK003";
pub const V3_SEAT_SHARD_DISCRIMINATOR: [u8; 8] = *b"STKST003";
pub const V3_EVENT_SHARD_DISCRIMINATOR: [u8; 8] = *b"STKEV003";

// `MarketCoreV3` byte offsets used by lifecycle code. They are named here,
// beside the packed layout, rather than duplicated as fragile literals in
// MagicBlock handlers.
pub const V3_CORE_MODE_OFFSET: usize = 11;
pub const V3_CORE_INSTRUMENT_OFFSET: usize = 12;
pub const V3_CORE_MARKET_AUTHORITY_OFFSET: usize = 44;
pub const V3_CORE_DELEGATION_STATUS_OFFSET: usize = 197;
pub const V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET: usize = 198;
pub const V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET: usize = 206;
pub const V3_CORE_VALIDATOR_OFFSET: usize = 214;

pub const V3_BOOK_NODES_PER_PAGE: usize = 256;
pub const V3_BOOK_PAGES_PER_SIDE: usize = 4;
pub const V3_BOOK_SLOTS_PER_SIDE: usize = V3_BOOK_NODES_PER_PAGE * V3_BOOK_PAGES_PER_SIDE;
pub const V3_SEATS_PER_SHARD: usize = 32;
pub const V3_SEAT_SHARDS: usize = 4;
pub const V3_EVENTS_PER_SHARD: usize = 32;
pub const V3_EVENT_SHARDS: usize = 4;

/// Wire-stable account kinds for V3 creation and bundle validation. `BookPage`
/// uses a flattened index (`side * 4 + page`) so callers cannot supply an
/// ambiguous side/page pair.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum V3AccountKind {
    MarketCore = 0,
    BookPage = 1,
    SeatShard = 2,
    EventShard = 3,
}

impl V3AccountKind {
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::MarketCore),
            1 => Some(Self::BookPage),
            2 => Some(Self::SeatShard),
            3 => Some(Self::EventShard),
            _ => None,
        }
    }
    pub const fn max_index(self) -> u8 {
        match self {
            Self::MarketCore => 0,
            Self::BookPage => 7,
            Self::SeatShard => 3,
            Self::EventShard => 3,
        }
    }
    pub const fn account_size(self) -> usize {
        match self {
            Self::MarketCore => V3_MARKET_CORE_SIZE,
            Self::BookPage => V3_BOOK_PAGE_SIZE,
            Self::SeatShard => V3_SEAT_SHARD_SIZE,
            Self::EventShard => V3_EVENT_SHARD_SIZE,
        }
    }
}

/// A V3 core contains only durable market/risk/delegation metadata. The
/// order book, seats and event queue live in independently committable pages.
#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct MarketCoreV3 {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub mode: u8,
    pub instrument: [u8; 32],
    pub market_authority: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub collateral_token_program: [u8; 32],
    pub global_order_sequence: u64,
    pub global_event_sequence: u64,
    pub funding_accumulator: i128,
    pub last_funding_timestamp: u64,
    pub oracle_valid: u8,
    pub last_verified_oracle_price: i64,
    pub last_verified_oracle_timestamp: u64,
    pub delegation_status: u8,
    pub expected_commit_sequence: u64,
    pub last_committed_sequence: u64,
    pub reserved: [u8; 3_882],
}
pub const V3_MARKET_CORE_SIZE: usize = size_of::<MarketCoreV3>();

/// An order-book page stores exactly 256 V2-compatible 88-byte node slots.
/// Roots/free lists stay in page zero metadata; nodes use stable global
/// indices (`page * 256 + local`) so PATRICIA traversal remains deterministic.
#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct BookPageV3 {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub side: u8,
    pub page_index: u8,
    pub market: [u8; 32],
    pub fixed_root: u32,
    pub pegged_root: u32,
    pub free_head: u32,
    pub free_count: u32,
    pub node_count: u32,
    pub nodes: [[u8; 88]; V3_BOOK_NODES_PER_PAGE],
}
pub const V3_BOOK_PAGE_SIZE: usize = size_of::<BookPageV3>();

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SeatShardV3 {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub shard_index: u8,
    pub reserved: u8,
    pub market: [u8; 32],
    pub seats: [[u8; 256]; V3_SEATS_PER_SHARD],
}
pub const V3_SEAT_SHARD_SIZE: usize = size_of::<SeatShardV3>();

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct EventShardV3 {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub shard_index: u8,
    pub reserved: u8,
    pub market: [u8; 32],
    pub events: [[u8; 64]; V3_EVENTS_PER_SHARD],
}
pub const V3_EVENT_SHARD_SIZE: usize = size_of::<EventShardV3>();

const _: [(); 4_096] = [(); V3_MARKET_CORE_SIZE];
const _: [(); 22_592] = [(); V3_BOOK_PAGE_SIZE];
const _: [(); 8_236] = [(); V3_SEAT_SHARD_SIZE];
const _: [(); 2_092] = [(); V3_EVENT_SHARD_SIZE];

/// Every account that may be delegated must satisfy this bound before it is
/// created. This is a layout gate, not an attempt to infer a runtime error.
pub const fn committable_account_size(size: usize) -> bool {
    size <= V3_COMMIT_ACCOUNT_SAFE_MAX && size <= V3_COMMIT_ACCOUNT_HARD_MAX
}

pub const fn v3_layout_is_committable() -> bool {
    committable_account_size(V3_MARKET_CORE_SIZE)
        && committable_account_size(V3_BOOK_PAGE_SIZE)
        && committable_account_size(V3_SEAT_SHARD_SIZE)
        && committable_account_size(V3_EVENT_SHARD_SIZE)
        && V3_BOOK_SLOTS_PER_SIDE == 1_024
        && V3_SEATS_PER_SHARD * V3_SEAT_SHARDS == 128
}

pub fn derive_market_core_v3(program_id: &Address, instrument: &Address) -> Address {
    Address::find_program_address(&[V3_MARKET_CORE_SEED, instrument.as_ref()], program_id).0
}

pub fn derive_book_page_v3(program_id: &Address, market: &Address, side: u8, page: u8) -> Address {
    Address::find_program_address(
        &[V3_BOOK_PAGE_SEED, market.as_ref(), &[side], &[page]],
        program_id,
    )
    .0
}

pub fn derive_seat_shard_v3(program_id: &Address, market: &Address, shard: u8) -> Address {
    Address::find_program_address(&[V3_SEAT_SHARD_SEED, market.as_ref(), &[shard]], program_id).0
}

pub fn derive_event_shard_v3(program_id: &Address, market: &Address, shard: u8) -> Address {
    Address::find_program_address(
        &[V3_EVENT_SHARD_SEED, market.as_ref(), &[shard]],
        program_id,
    )
    .0
}

/// Derives exactly one V3 account. `parent` is the instrument only for the
/// core; for every shard it is the V3 market core. Bounds are checked before
/// deriving so a malformed page cannot alias a valid PDA through wrapping.
pub fn derive_v3_account(
    program_id: &Address,
    parent: &Address,
    kind: V3AccountKind,
    index: u8,
) -> Option<Address> {
    if index > kind.max_index() {
        return None;
    }
    Some(match kind {
        V3AccountKind::MarketCore => derive_market_core_v3(program_id, parent),
        V3AccountKind::BookPage => derive_book_page_v3(
            program_id,
            parent,
            index / V3_BOOK_PAGES_PER_SIDE as u8,
            index % V3_BOOK_PAGES_PER_SIDE as u8,
        ),
        V3AccountKind::SeatShard => derive_seat_shard_v3(program_id, parent, index),
        V3AccountKind::EventShard => derive_event_shard_v3(program_id, parent, index),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MARKET_ACCOUNT_SIZE;

    #[test]
    fn v3_pages_preserve_capacity_and_fit_magicblock_commit_bounds() {
        assert!(v3_layout_is_committable());
        assert_eq!(V3_BOOK_SLOTS_PER_SIDE, 1_024);
        assert!(V3_BOOK_PAGE_SIZE < V3_COMMIT_ACCOUNT_SAFE_MAX);
        assert!(V3_BOOK_PAGE_SIZE < V3_COMMIT_ACCOUNT_HARD_MAX);
    }

    #[test]
    fn v2_monolith_is_rejected_by_v3_commit_layout_gate() {
        assert!(MARKET_ACCOUNT_SIZE > V3_COMMIT_ACCOUNT_HARD_MAX);
        assert!(!committable_account_size(MARKET_ACCOUNT_SIZE));
    }

    #[test]
    fn v3_account_kinds_are_bounded_and_non_aliasing() {
        let id = Address::new_from_array([7; 32]);
        let market = derive_market_core_v3(&id, &Address::new_from_array([8; 32]));
        assert_eq!(V3AccountKind::BookPage.account_size(), V3_BOOK_PAGE_SIZE);
        assert!(derive_v3_account(&id, &market, V3AccountKind::BookPage, 8).is_none());
        assert_ne!(
            derive_v3_account(&id, &market, V3AccountKind::BookPage, 0),
            derive_v3_account(&id, &market, V3AccountKind::BookPage, 1)
        );
    }
}
