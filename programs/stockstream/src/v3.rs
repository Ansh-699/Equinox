//! Version-three, MagicBlock-committable market account layout.
//!
//! V2 deliberately remains supported for the already-delegated Devnet market.
//! V3 never reinterprets a V2 account: every V3 PDA is separately derived
//! from the V3 core address and has an explicit discriminator/version.
//!
//! MagicBlock's deployed scheduler rejects a committed account larger than
//! Solana's `MAX_PERMITTED_DATA_INCREASE` (10,240 bytes).  The V3 hot state
//! therefore uses only accounts below that *actual* commit limit, not merely
//! below the wire-level `u16` state-length ceiling.

use core::{
    mem::{size_of, MaybeUninit},
    ptr,
};

use pinocchio::sysvars::{rent::Rent, Sysvar};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_token::{instructions::Transfer, state::Account as TokenAccount};

use crate::{
    book::{
        InnerNode, LeafNode, OrderInput, SelfTradeBehavior, Side, TimeInForce, TreeKind,
        ANY_NODE_SIZE, NONE, TAG_INNER, TAG_LEAF,
    },
    error::StockStreamError,
    instruction::{PlaceOrderData, StockStreamInstruction},
    session::{self, TradingSession},
    state::{DelegationStatus, LiquidationState, TraderSeat, TRADER_SEAT_SIZE},
};

/// The V3 trading ABI places the complete execution bundle first, followed by
/// the transaction signer and (for delegated sessions) one writable session
/// PDA. Keeping the signer outside the bundle means every shard can remain a
/// deterministic PDA set while the authorization account stays ephemeral.
pub const V3_SIGNER_ACCOUNT_INDEX: usize = V3_EXECUTION_BUNDLE_LEN;
pub const V3_SESSION_ACCOUNT_INDEX: usize = V3_EXECUTION_BUNDLE_LEN + 1;

pub const V3_LAYOUT_VERSION: u16 = 3;
pub const V3_COMMIT_ACCOUNT_HARD_MAX: usize = u16::MAX as usize;
/// `magicblock-program::validate_commit_type_accounts` currently rejects a
/// delegated account whose data length exceeds this value.
pub const V3_COMMIT_ACCOUNT_SAFE_MAX: usize = 10_240;
pub const V3_PAGE_ACCOUNT_SIZE: usize = V3_COMMIT_ACCOUNT_SAFE_MAX;

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
pub const V3_CORE_GLOBAL_ORDER_SEQUENCE_OFFSET: usize = 140;
pub const V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET: usize = 148;
pub const V3_CORE_FUNDING_ACCUMULATOR_OFFSET: usize = 156;
pub const V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET: usize = 172;
pub const V3_CORE_ORACLE_VALID_OFFSET: usize = 180;
pub const V3_CORE_ORACLE_PRICE_OFFSET: usize = 181;
pub const V3_CORE_ORACLE_TIMESTAMP_OFFSET: usize = 189;
pub const V3_CORE_DELEGATION_STATUS_OFFSET: usize = 197;
pub const V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET: usize = 198;
pub const V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET: usize = 206;
pub const V3_CORE_VALIDATOR_OFFSET: usize = 214;
/// V3 oracle configuration is copied from the registered instrument at
/// activation. These bytes live after the fixed lifecycle fields in the
/// durable core reserve and are read by the verified Pyth update path.
pub const V3_CORE_ORACLE_FEED_ID_OFFSET: usize = 246;
pub const V3_CORE_ORACLE_CHANNEL_OFFSET: usize = 250;
pub const V3_CORE_ORACLE_EXPONENT_OFFSET: usize = 251;
// Durable risk/economic configuration lives in the versioned core reserve;
// keeping these offsets explicit preserves the 4,096-byte MagicBlock-safe
// account size while making V3 economics independent of V2 arena offsets.
pub const V3_CORE_INITIAL_MARGIN_BPS_OFFSET: usize = 218;
pub const V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET: usize = 220;
pub const V3_CORE_LIQUIDATION_FEE_BPS_OFFSET: usize = 222;
pub const V3_CORE_MAKER_FEE_BPS_OFFSET: usize = 224;
pub const V3_CORE_TAKER_FEE_BPS_OFFSET: usize = 226;
pub const V3_CORE_MAXIMUM_LEVERAGE_OFFSET: usize = 228;
pub const V3_CORE_MAXIMUM_POSITION_OFFSET: usize = 256;
pub const V3_CORE_MAXIMUM_OPEN_INTEREST_OFFSET: usize = 272;
pub const V3_CORE_CURRENT_OPEN_INTEREST_OFFSET: usize = 288;
pub const V3_CORE_MARK_DEVIATION_BPS_OFFSET: usize = 304;
pub const V3_CORE_PROTOCOL_FEE_BALANCE_OFFSET: usize = 306;
pub const V3_CORE_INSURANCE_BALANCE_OFFSET: usize = 322;
pub const V3_CORE_BAD_DEBT_OFFSET: usize = 338;
pub const V3_CORE_VAULT_LIABILITY_OFFSET: usize = 354;
pub const V3_CORE_RECONCILIATION_STATUS_OFFSET: usize = 370;
pub const V3_CORE_RISK_CONFIG_VERSION_OFFSET: usize = 371;
/// Commit state is durable in the core reserve.  A non-zero phase freezes
/// trading while a single snapshot epoch is being committed child-by-child.
pub const V3_CORE_COMMIT_PHASE_OFFSET: usize = 372;
pub const V3_CORE_SNAPSHOT_EPOCH_OFFSET: usize = 376;
pub const V3_CORE_SNAPSHOT_CHILD_COUNT_OFFSET: usize = 384;
pub const V3_CORE_CHILD_RECORDS_OFFSET: usize = 392;
pub const V3_CORE_CHILD_RECORD_SIZE: usize = 48; // epoch + sequence + 32-byte digest
pub const V3_CHILD_COUNT: usize = V3_EXECUTION_BUNDLE_LEN - 1;
pub const V3_COMMIT_PHASE_IDLE: u8 = 0;
pub const V3_COMMIT_PHASE_SNAPSHOT: u8 = 1;
pub const V3_COMMIT_PHASE_UNDELEGATING: u8 = 2;

pub const V3_RISK_CONFIG_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct V3RiskConfig {
    pub initial_margin_bps: u16,
    pub maintenance_margin_bps: u16,
    pub liquidation_fee_bps: u16,
    pub maker_fee_bps: u16,
    pub taker_fee_bps: u16,
    pub maximum_leverage: u32,
    pub maximum_position: i128,
    pub maximum_open_interest: i128,
    pub mark_deviation_bps: u16,
}

impl V3RiskConfig {
    pub const fn defaults() -> Self {
        Self {
            initial_margin_bps: 2_000,
            maintenance_margin_bps: 1_000,
            liquidation_fee_bps: 50,
            maker_fee_bps: 0,
            taker_fee_bps: 5,
            maximum_leverage: 5,
            maximum_position: 0,
            maximum_open_interest: 0,
            mark_deviation_bps: 0,
        }
    }
}

/// `64 + 115 * 88 = 10,184`, safely below the scheduler's 10,240-byte
/// per-account limit. Nine pages provide physical room for 1,035 nodes; the
/// allocator is intentionally capped at the protocol's exact 1,024 slots.
pub const V3_BOOK_NODES_PER_PAGE: usize = 115;
pub const V3_BOOK_PAGES_PER_SIDE: usize = 9;
pub const V3_BOOK_SLOTS_PER_SIDE: usize = 1_024;
pub const V3_SEATS_PER_SHARD: usize = 32;
pub const V3_SEAT_SHARDS: usize = 4;
pub const V3_EVENTS_PER_SHARD: usize = 32;
pub const V3_EVENT_SHARDS: usize = 4;
pub const V3_EVENT_RECORD_SIZE: usize = crate::events::EVENT_SIZE;
pub const V3_SEAT_OCCUPANCY_OFFSET: usize = 0;
pub const V3_SEAT_TRADER_OFFSET: usize = 1;
pub const V3_SEAT_AVAILABLE_COLLATERAL_OFFSET: usize = 40;
pub const V3_SEAT_RESERVED_MARGIN_OFFSET: usize = 56;
pub const V3_SEAT_BASE_POSITION_OFFSET: usize = 72;
pub const V3_SEAT_QUOTE_ENTRY_VALUE_OFFSET: usize = 88;
pub const V3_SEAT_REALIZED_PNL_OFFSET: usize = 104;
pub const V3_SEAT_LAST_FUNDING_OFFSET: usize = 120;
pub const V3_SEAT_OPEN_BID_EXPOSURE_OFFSET: usize = 136;
pub const V3_SEAT_OPEN_ASK_EXPOSURE_OFFSET: usize = 152;
pub const V3_SEAT_OPEN_ORDER_COUNT_OFFSET: usize = 168;
pub const V3_SEAT_LIQUIDATION_STATE_OFFSET: usize = 172;
pub const V3_SEAT_SEQUENCE_OFFSET: usize = 176;
/// One fully hot V3 execution domain: core, 18 pages, 4 seat shards, and 4
/// event shards. Vaults remain outside this bundle on L1 by design.
pub const V3_EXECUTION_BUNDLE_LEN: usize =
    1 + (2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS + V3_EVENT_SHARDS;
const V3_SHARD_HEADER_SIZE: usize = 44;
const V3_BOOK_HEADER_SIZE: usize = 64;
const V3_BOOK_FIXED_ROOT_OFFSET: usize = 44;
const V3_BOOK_PEGGED_ROOT_OFFSET: usize = 48;
const V3_BOOK_FREE_HEAD_OFFSET: usize = 52;
const V3_BOOK_FREE_COUNT_OFFSET: usize = 56;
/// Page zero owns the side-global bump cursor.  Other pages retain zero here;
/// their page number is sufficient to resolve a global node handle.
const V3_BOOK_BUMP_INDEX_OFFSET: usize = 60;
const V3_TAG_UNINITIALIZED: u8 = 0;
const V3_TAG_FREE: u8 = 3;
const V3_TAG_LAST_FREE: u8 = 4;

/// Wire-stable account kinds for V3 creation and bundle validation. `BookPage`
/// uses a flattened index (`side * V3_BOOK_PAGES_PER_SIDE + page`) so callers cannot supply an
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
            Self::BookPage => (2 * V3_BOOK_PAGES_PER_SIDE - 1) as u8,
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

/// An order-book page stores 115 V2-compatible 88-byte node slots.
/// Roots/free lists stay in page zero metadata; nodes use stable global
/// indices (`page * 115 + local`) so PATRICIA traversal remains deterministic.
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
    pub events: [[u8; V3_EVENT_RECORD_SIZE]; V3_EVENTS_PER_SHARD],
}
pub const V3_EVENT_SHARD_SIZE: usize = size_of::<EventShardV3>();

const _: [(); 4_096] = [(); V3_MARKET_CORE_SIZE];
const _: [(); 10_184] = [(); V3_BOOK_PAGE_SIZE];
const _: [(); 8_236] = [(); V3_SEAT_SHARD_SIZE];
const _: [(); 3_244] = [(); V3_EVENT_SHARD_SIZE];

#[cfg(test)]
const _: () = {
    assert!(core::mem::offset_of!(TraderSeat, occupancy) == V3_SEAT_OCCUPANCY_OFFSET);
    assert!(core::mem::offset_of!(TraderSeat, trader) == V3_SEAT_TRADER_OFFSET);
    assert!(
        core::mem::offset_of!(TraderSeat, available_collateral)
            == V3_SEAT_AVAILABLE_COLLATERAL_OFFSET
    );
    assert!(core::mem::offset_of!(TraderSeat, reserved_margin) == V3_SEAT_RESERVED_MARGIN_OFFSET);
    assert!(core::mem::offset_of!(TraderSeat, base_position) == V3_SEAT_BASE_POSITION_OFFSET);
    assert!(
        core::mem::offset_of!(TraderSeat, quote_entry_value) == V3_SEAT_QUOTE_ENTRY_VALUE_OFFSET
    );
    assert!(core::mem::offset_of!(TraderSeat, realized_pnl) == V3_SEAT_REALIZED_PNL_OFFSET);
    assert!(
        core::mem::offset_of!(TraderSeat, last_funding_accumulator) == V3_SEAT_LAST_FUNDING_OFFSET
    );
    assert!(
        core::mem::offset_of!(TraderSeat, open_bid_exposure) == V3_SEAT_OPEN_BID_EXPOSURE_OFFSET
    );
    assert!(
        core::mem::offset_of!(TraderSeat, open_ask_exposure) == V3_SEAT_OPEN_ASK_EXPOSURE_OFFSET
    );
    assert!(core::mem::offset_of!(TraderSeat, open_order_count) == V3_SEAT_OPEN_ORDER_COUNT_OFFSET);
    assert!(
        core::mem::offset_of!(TraderSeat, liquidation_state) == V3_SEAT_LIQUIDATION_STATE_OFFSET
    );
    assert!(core::mem::offset_of!(TraderSeat, sequence) == V3_SEAT_SEQUENCE_OFFSET);
};

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

/// A page-aware PATRICIA store for exactly one V3 side. Nodes retain the V2
/// 88-byte representation and use side-global handles (`page * 115 + slot`),
/// so an inner node may point into any page without a caller-selectable
/// translation layer. Page zero owns both roots and the global free/bump
/// metadata; pages 1..3 contain node slots only.
///
/// The adapter is deliberately account-backed, not a copied `Arena`: every
/// mutation is immediately applied to the supplied validated PDA pages.
pub struct PagedBookV3<'a> {
    pages: &'a mut [AccountView],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct V3Fill {
    pub maker_tree: u8,
    pub maker_handle: u32,
    pub maker_owner: u32,
    pub key: u128,
    pub price: u64,
    pub quantity: u64,
    pub maker_remaining: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct V3SelfTradeCancellation {
    pub maker_tree: u8,
    pub maker_handle: u32,
    pub maker_owner: u32,
    pub key: u128,
    pub quantity: u64,
    pub price: u64,
    pub side: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct V3MatchPlan {
    pub fills: [V3Fill; crate::book::MAX_FILLS_PER_INSTRUCTION],
    pub fill_count: u8,
    pub taker_remaining: u64,
    pub cancellations: [V3SelfTradeCancellation; crate::book::MAX_FILLS_PER_INSTRUCTION],
    pub cancellation_count: u8,
}

const EMPTY_V3_FILL: V3Fill = V3Fill {
    maker_tree: 0,
    maker_handle: NONE,
    maker_owner: 0,
    key: 0,
    price: 0,
    quantity: 0,
    maker_remaining: 0,
};
const EMPTY_V3_CANCELLATION: V3SelfTradeCancellation = V3SelfTradeCancellation {
    maker_tree: 0,
    maker_handle: NONE,
    maker_owner: 0,
    key: 0,
    quantity: 0,
    price: 0,
    side: 0,
};

impl<'a> PagedBookV3<'a> {
    pub fn new(pages: &'a mut [AccountView]) -> Result<Self, ProgramError> {
        if pages.len() != V3_BOOK_PAGES_PER_SIDE {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        Ok(Self { pages })
    }

    fn page_slot(handle: u32) -> Result<(usize, usize), ProgramError> {
        if handle as usize >= V3_BOOK_SLOTS_PER_SIDE {
            return Err(bundle_error());
        }
        Ok((
            handle as usize / V3_BOOK_NODES_PER_PAGE,
            handle as usize % V3_BOOK_NODES_PER_PAGE,
        ))
    }

    fn node_offset(slot: usize) -> usize {
        V3_BOOK_HEADER_SIZE + slot * ANY_NODE_SIZE
    }

    fn meta_u32(&mut self, offset: usize) -> Result<u32, ProgramError> {
        let data = unsafe { self.pages[0].borrow_unchecked() };
        let raw: [u8; 4] = data
            .get(offset..offset + 4)
            .ok_or_else(bundle_error)?
            .try_into()
            .map_err(|_| bundle_error())?;
        Ok(u32::from_le_bytes(raw))
    }

    fn set_meta_u32(&mut self, offset: usize, value: u32) -> ProgramResult {
        let mut data = unsafe { self.pages[0].borrow_unchecked_mut() };
        let dst = data.get_mut(offset..offset + 4).ok_or_else(bundle_error)?;
        dst.copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    fn root_offset(tree: TreeKind) -> usize {
        match tree {
            TreeKind::Fixed => V3_BOOK_FIXED_ROOT_OFFSET,
            TreeKind::OraclePegged => V3_BOOK_PEGGED_ROOT_OFFSET,
        }
    }
    fn root(&mut self, tree: TreeKind) -> Result<u32, ProgramError> {
        self.meta_u32(Self::root_offset(tree))
    }
    fn set_root(&mut self, tree: TreeKind, value: u32) -> ProgramResult {
        self.set_meta_u32(Self::root_offset(tree), value)
    }

    fn node_bytes(&mut self, handle: u32) -> Result<[u8; ANY_NODE_SIZE], ProgramError> {
        let (page, slot) = Self::page_slot(handle)?;
        let data = unsafe { self.pages[page].borrow_unchecked() };
        let start = Self::node_offset(slot);
        let raw = data
            .get(start..start + ANY_NODE_SIZE)
            .ok_or_else(bundle_error)?;
        raw.try_into().map_err(|_| bundle_error())
    }
    fn put_node_bytes(&mut self, handle: u32, node: &[u8; ANY_NODE_SIZE]) -> ProgramResult {
        let (page, slot) = Self::page_slot(handle)?;
        let mut data = unsafe { self.pages[page].borrow_unchecked_mut() };
        let start = Self::node_offset(slot);
        data.get_mut(start..start + ANY_NODE_SIZE)
            .ok_or_else(bundle_error)?
            .copy_from_slice(node);
        Ok(())
    }
    fn tag(&mut self, handle: u32) -> Result<u8, ProgramError> {
        Ok(self.node_bytes(handle)?[0])
    }
    pub fn node_tag(&mut self, handle: u32) -> Result<u8, ProgramError> {
        self.tag(handle)
    }
    pub fn leaf(&mut self, handle: u32) -> Result<LeafNode, ProgramError> {
        let raw = self.node_bytes(handle)?;
        if raw[0] != TAG_LEAF {
            return Err(bundle_error());
        }
        let mut leaf = MaybeUninit::<LeafNode>::uninit();
        unsafe {
            ptr::copy_nonoverlapping(raw.as_ptr(), leaf.as_mut_ptr().cast(), ANY_NODE_SIZE);
            Ok(leaf.assume_init())
        }
    }
    fn inner(&mut self, handle: u32) -> Result<InnerNode, ProgramError> {
        let raw = self.node_bytes(handle)?;
        if raw[0] != TAG_INNER {
            return Err(bundle_error());
        }
        let mut node = MaybeUninit::<InnerNode>::uninit();
        unsafe {
            ptr::copy_nonoverlapping(raw.as_ptr(), node.as_mut_ptr().cast(), ANY_NODE_SIZE);
            Ok(node.assume_init())
        }
    }
    fn put_leaf(&mut self, handle: u32, leaf: LeafNode) -> ProgramResult {
        let mut raw = [0u8; ANY_NODE_SIZE];
        unsafe {
            ptr::copy_nonoverlapping(
                (&leaf as *const LeafNode).cast(),
                raw.as_mut_ptr(),
                ANY_NODE_SIZE,
            );
        }
        self.put_node_bytes(handle, &raw)
    }
    fn put_inner(&mut self, handle: u32, node: InnerNode) -> ProgramResult {
        let mut raw = [0u8; ANY_NODE_SIZE];
        unsafe {
            ptr::copy_nonoverlapping(
                (&node as *const InnerNode).cast(),
                raw.as_mut_ptr(),
                ANY_NODE_SIZE,
            );
        }
        self.put_node_bytes(handle, &raw)
    }

    fn subtree_expiry(&mut self, handle: u32) -> Result<u64, ProgramError> {
        match self.tag(handle)? {
            TAG_LEAF => {
                let leaf = self.leaf(handle)?;
                Ok(unsafe { core::ptr::addr_of!(leaf.expires_at).read_unaligned() })
            }
            TAG_INNER => {
                let inner = self.inner(handle)?;
                let values = inner.child_earliest_expiry;
                Ok(values[0].min(values[1]))
            }
            _ => Err(bundle_error()),
        }
    }

    fn refresh_inner(&mut self, handle: u32) -> ProgramResult {
        let mut inner = self.inner(handle)?;
        let children = inner.children;
        inner.child_earliest_expiry = [
            self.subtree_expiry(children[0])?,
            self.subtree_expiry(children[1])?,
        ];
        self.put_inner(handle, inner)
    }

    fn allocate(&mut self) -> Result<u32, ProgramError> {
        let free = self.meta_u32(V3_BOOK_FREE_HEAD_OFFSET)?;
        if free != NONE {
            let tag = self.tag(free)?;
            let next = match tag {
                V3_TAG_FREE => u32::from_le_bytes(self.node_bytes(free)?[4..8].try_into().unwrap()),
                V3_TAG_LAST_FREE => NONE,
                _ => return Err(bundle_error()),
            };
            let count = self
                .meta_u32(V3_BOOK_FREE_COUNT_OFFSET)?
                .checked_sub(1)
                .ok_or_else(bundle_error)?;
            self.set_meta_u32(V3_BOOK_FREE_HEAD_OFFSET, next)?;
            self.set_meta_u32(V3_BOOK_FREE_COUNT_OFFSET, count)?;
            return Ok(free);
        }
        let bump = self.meta_u32(V3_BOOK_BUMP_INDEX_OFFSET)?;
        if bump as usize >= V3_BOOK_SLOTS_PER_SIDE {
            return Err(StockStreamError::V3BookFull.into());
        }
        self.set_meta_u32(V3_BOOK_BUMP_INDEX_OFFSET, bump + 1)?;
        Ok(bump)
    }

    fn recycle(&mut self, handle: u32) -> ProgramResult {
        let bump = self.meta_u32(V3_BOOK_BUMP_INDEX_OFFSET)?;
        if handle >= bump || self.tag(handle)? == V3_TAG_UNINITIALIZED {
            return Err(bundle_error());
        }
        let free = self.meta_u32(V3_BOOK_FREE_HEAD_OFFSET)?;
        let mut raw = [0u8; ANY_NODE_SIZE];
        if free == NONE {
            raw[0] = V3_TAG_LAST_FREE;
        } else {
            raw[0] = V3_TAG_FREE;
            raw[4..8].copy_from_slice(&free.to_le_bytes());
        }
        self.put_node_bytes(handle, &raw)?;
        self.set_meta_u32(V3_BOOK_FREE_HEAD_OFFSET, handle)?;
        let next = self
            .meta_u32(V3_BOOK_FREE_COUNT_OFFSET)?
            .checked_add(1)
            .ok_or_else(bundle_error)?;
        self.set_meta_u32(V3_BOOK_FREE_COUNT_OFFSET, next)
    }

    fn common_prefix(left: u128, right: u128) -> u32 {
        (left ^ right).leading_zeros()
    }
    fn bit(key: u128, prefix: u32) -> usize {
        ((key >> (127 - prefix)) & 1) as usize
    }
    fn make_inner(
        prefix: u32,
        representative: u128,
        old: u32,
        new: u32,
        new_branch: usize,
    ) -> InnerNode {
        let mut children = [old, new];
        children[new_branch] = new;
        children[1 - new_branch] = old;
        InnerNode {
            tag: TAG_INNER,
            _padding: [0; 3],
            prefix_len: prefix,
            key: representative,
            children,
            child_earliest_expiry: [u64::MAX; 2],
            _reserved: [0; 40],
        }
    }

    /// Inserts a leaf into a fixed or oracle-pegged root. The traversal is
    /// bounded by the 128-bit key width and consumes at most two global node
    /// slots after the duplicate-key check.
    pub fn insert(&mut self, tree: TreeKind, leaf: LeafNode) -> Result<u32, ProgramError> {
        let key = leaf.key;
        let root = self.root(tree)?;
        if root == NONE {
            let handle = self.allocate()?;
            self.put_leaf(handle, leaf)?;
            self.set_root(tree, handle)?;
            return Ok(handle);
        }
        let mut path = [(NONE, 0usize); 128];
        let mut depth = 0usize;
        let mut current = root;
        loop {
            match self.tag(current)? {
                TAG_LEAF => {
                    let old = self.leaf(current)?;
                    if old.key == key {
                        return Err(bundle_error());
                    }
                    let prefix = Self::common_prefix(old.key, key);
                    let leaf_handle = self.allocate()?;
                    let inner_handle = match self.allocate() {
                        Ok(value) => value,
                        Err(error) => {
                            self.recycle(leaf_handle)?;
                            return Err(error);
                        }
                    };
                    self.put_leaf(leaf_handle, leaf)?;
                    self.put_inner(
                        inner_handle,
                        Self::make_inner(
                            prefix,
                            old.key,
                            current,
                            leaf_handle,
                            Self::bit(key, prefix),
                        ),
                    )?;
                    self.refresh_inner(inner_handle)?;
                    self.replace_child(tree, &path[..depth], inner_handle)?;
                    return Ok(leaf_handle);
                }
                TAG_INNER => {
                    let old = self.inner(current)?;
                    let common = Self::common_prefix(old.key, key);
                    if common < old.prefix_len {
                        let leaf_handle = self.allocate()?;
                        let inner_handle = match self.allocate() {
                            Ok(value) => value,
                            Err(error) => {
                                self.recycle(leaf_handle)?;
                                return Err(error);
                            }
                        };
                        self.put_leaf(leaf_handle, leaf)?;
                        self.put_inner(
                            inner_handle,
                            Self::make_inner(
                                common,
                                old.key,
                                current,
                                leaf_handle,
                                Self::bit(key, common),
                            ),
                        )?;
                        self.refresh_inner(inner_handle)?;
                        self.replace_child(tree, &path[..depth], inner_handle)?;
                        return Ok(leaf_handle);
                    }
                    if depth == path.len() {
                        return Err(bundle_error());
                    }
                    let branch = Self::bit(key, old.prefix_len);
                    path[depth] = (current, branch);
                    depth += 1;
                    current = old.children[branch];
                }
                _ => return Err(bundle_error()),
            }
        }
    }

    fn replace_child(
        &mut self,
        tree: TreeKind,
        path: &[(u32, usize)],
        replacement: u32,
    ) -> ProgramResult {
        if let Some((parent, branch)) = path.last() {
            let mut inner = self.inner(*parent)?;
            inner.children[*branch] = replacement;
            self.put_inner(*parent, inner)?;
            self.refresh_inner(*parent)?;
            for (ancestor, _) in path[..path.len() - 1].iter().rev() {
                self.refresh_inner(*ancestor)?;
            }
            Ok(())
        } else {
            self.set_root(tree, replacement)
        }
    }

    pub fn find(&mut self, tree: TreeKind, key: u128) -> Result<u32, ProgramError> {
        let mut current = self.root(tree)?;
        while current != NONE {
            match self.tag(current)? {
                TAG_LEAF => {
                    return (self.leaf(current)?.key == key)
                        .then_some(current)
                        .ok_or_else(bundle_error)
                }
                TAG_INNER => {
                    let inner = self.inner(current)?;
                    if Self::common_prefix(inner.key, key) < inner.prefix_len {
                        return Err(bundle_error());
                    }
                    current = inner.children[Self::bit(key, inner.prefix_len)];
                }
                _ => return Err(bundle_error()),
            }
        }
        Err(bundle_error())
    }

    /// Removes a leaf and its now-unneeded parent inner node. Both handles are
    /// returned to the global free list, allowing a later insert to reuse a
    /// slot on any page before consuming the bump cursor.
    pub fn remove(&mut self, tree: TreeKind, key: u128) -> Result<LeafNode, ProgramError> {
        let root = self.root(tree)?;
        if root == NONE {
            return Err(bundle_error());
        }
        let mut path = [(NONE, 0usize); 128];
        let mut depth = 0usize;
        let mut current = root;
        while self.tag(current)? == TAG_INNER {
            let inner = self.inner(current)?;
            if Self::common_prefix(inner.key, key) < inner.prefix_len || depth == path.len() {
                return Err(bundle_error());
            }
            let branch = Self::bit(key, inner.prefix_len);
            path[depth] = (current, branch);
            depth += 1;
            current = inner.children[branch];
        }
        let leaf = self.leaf(current)?;
        if leaf.key != key {
            return Err(bundle_error());
        }
        if depth == 0 {
            self.set_root(tree, NONE)?;
        } else {
            let (parent_handle, branch) = path[depth - 1];
            let parent = self.inner(parent_handle)?;
            self.replace_child(tree, &path[..depth - 1], parent.children[1 - branch])?;
            self.recycle(parent_handle)?;
        }
        self.recycle(current)?;
        Ok(leaf)
    }

    pub fn remove_owned(
        &mut self,
        tree: TreeKind,
        key: u128,
        owner: u32,
    ) -> Result<LeafNode, ProgramError> {
        let handle = self.find(tree, key)?;
        if self.leaf(handle)?.owner != owner {
            return Err(bundle_error());
        }
        self.remove(tree, key)
    }

    /// Inserts one already-authorized resting order into the page-sharded
    /// book.  The caller must derive the key with `OrderInput::leaf`; this
    /// wrapper deliberately accepts the canonical `LeafNode` rather than
    /// exposing page selection or raw handles to an instruction caller.
    pub fn insert_resting_order(
        &mut self,
        tree: TreeKind,
        leaf: LeafNode,
    ) -> Result<u32, ProgramError> {
        if leaf.tag != TAG_LEAF || leaf.quantity == 0 || leaf.side > 1 {
            return Err(bundle_error());
        }
        self.insert(tree, leaf)
    }

    /// Cancels only an order owned by the supplied V3 seat.  Returning the
    /// removed leaf lets the settlement layer apply the seat's reserved
    /// margin/open-order deltas atomically before committing the event.
    pub fn cancel_owned_order(
        &mut self,
        tree: TreeKind,
        key: u128,
        owner: u32,
    ) -> Result<LeafNode, ProgramError> {
        self.remove_owned(tree, key, owner)
    }

    pub fn best(&mut self, tree: TreeKind) -> Result<Option<u32>, ProgramError> {
        let mut current = self.root(tree)?;
        while current != NONE {
            match self.tag(current)? {
                TAG_LEAF => return Ok(Some(current)),
                TAG_INNER => current = self.inner(current)?.children[0],
                _ => return Err(bundle_error()),
            }
        }
        Ok(None)
    }

    /// Returns the best executable quote for one side of this page-sharded
    /// book.  Roots and node handles remain global, so traversal is identical
    /// to the matcher; only the leaf bytes are read from their owning page.
    pub fn best_executable_price(
        &mut self,
        tree: TreeKind,
        side: Side,
        oracle: i64,
        now: u64,
    ) -> Result<Option<i64>, ProgramError> {
        let Some(handle) = self.best(tree)? else {
            return Ok(None);
        };
        let leaf = self.leaf(handle)?;
        let expires_at = unsafe { core::ptr::addr_of!(leaf.expires_at).read_unaligned() };
        let quantity = unsafe { core::ptr::addr_of!(leaf.quantity).read_unaligned() };
        let leaf_side = leaf.side;
        if quantity == 0 || expires_at <= now || leaf_side != side as u8 {
            return Ok(None);
        }
        let raw = unsafe { core::ptr::addr_of!(leaf.price_or_offset).read_unaligned() };
        let price = match tree {
            TreeKind::Fixed => raw,
            TreeKind::OraclePegged => match crate::book::pegged_state(&leaf, Some(oracle), now) {
                crate::book::PeggedState::Valid(value) => value,
                crate::book::PeggedState::Skipped | crate::book::PeggedState::Invalid => {
                    return Ok(None)
                }
            },
        };
        Ok((price > 0).then_some(price))
    }

    fn best_unselected(
        &mut self,
        tree: TreeKind,
        selected: &[u32; crate::book::MAX_FILLS_PER_INSTRUCTION],
        selected_len: usize,
    ) -> Result<Option<u32>, ProgramError> {
        let bump = self.meta_u32(V3_BOOK_BUMP_INDEX_OFFSET)? as usize;
        let mut best: Option<(u128, u32)> = None;
        for handle in 0..bump {
            let handle = handle as u32;
            if self.tag(handle)? != TAG_LEAF || selected[..selected_len].contains(&handle) {
                continue;
            }
            let leaf = self.leaf(handle)?;
            let key = unsafe { core::ptr::addr_of!(leaf.key).read_unaligned() };
            if self.find(tree, key).ok() != Some(handle) {
                continue;
            }
            if best.map(|(current, _)| key < current).unwrap_or(true) {
                best = Some((key, handle));
            }
        }
        Ok(best.map(|(_, handle)| handle))
    }

    fn best_unselected_across(
        &mut self,
        trees: &[TreeKind],
        side: Side,
        oracle: Option<i64>,
        now: u64,
        selected_trees: &[u8; crate::book::MAX_FILLS_PER_INSTRUCTION],
        selected: &[u32; crate::book::MAX_FILLS_PER_INSTRUCTION],
        selected_len: usize,
    ) -> Result<Option<(TreeKind, u32, u64)>, ProgramError> {
        let bump = self.meta_u32(V3_BOOK_BUMP_INDEX_OFFSET)? as usize;
        let mut best: Option<(u128, TreeKind, u32, u64)> = None;
        for tree in trees {
            for handle in 0..bump {
                let handle = handle as u32;
                if (0..selected_len)
                    .any(|index| selected_trees[index] == *tree as u8 && selected[index] == handle)
                    || self.tag(handle)? != TAG_LEAF
                {
                    continue;
                }
                let leaf = self.leaf(handle)?;
                if self
                    .find(*tree, unsafe {
                        core::ptr::addr_of!(leaf.key).read_unaligned()
                    })
                    .ok()
                    != Some(handle)
                {
                    continue;
                }
                let expires = unsafe { core::ptr::addr_of!(leaf.expires_at).read_unaligned() };
                if leaf.quantity == 0 || expires <= now || leaf.side != side as u8 {
                    continue;
                }
                let price = match *tree {
                    TreeKind::Fixed => {
                        let value =
                            unsafe { core::ptr::addr_of!(leaf.price_or_offset).read_unaligned() };
                        if value <= 0 {
                            continue;
                        }
                        value as u64
                    }
                    TreeKind::OraclePegged => match crate::book::pegged_state(&leaf, oracle, now) {
                        crate::book::PeggedState::Valid(value) => value as u64,
                        crate::book::PeggedState::Invalid | crate::book::PeggedState::Skipped => {
                            continue
                        }
                    },
                };
                let sequence = unsafe { core::ptr::addr_of!(leaf.sequence).read_unaligned() };
                let key = crate::book::price_time_key(side, price as i64, sequence)
                    .map_err(|_| bundle_error())?;
                if best.map(|current| key < current.0).unwrap_or(true) {
                    best = Some((key, *tree, handle, price));
                }
            }
        }
        Ok(best.map(|(_, tree, handle, price)| (tree, handle, price)))
    }

    fn effective_price(
        leaf: &LeafNode,
        tree: TreeKind,
        oracle: Option<i64>,
    ) -> Result<u64, ProgramError> {
        let raw = unsafe { core::ptr::addr_of!(leaf.price_or_offset).read_unaligned() };
        let value = match tree {
            TreeKind::Fixed => raw,
            TreeKind::OraclePegged => oracle
                .ok_or_else(bundle_error)?
                .checked_add(raw)
                .ok_or_else(bundle_error)?,
        };
        if value <= 0 {
            return Err(bundle_error());
        }
        Ok(value as u64)
    }

    /// Plans up to four crossing fills against this page-sharded book without
    /// mutating it. The selected handles and expected remaining quantities are
    /// carried into `apply_match_plan`, making stale-page races fail before a
    /// partial mutation can be committed.
    pub fn plan_crossing(
        &mut self,
        tree: TreeKind,
        taker_side: crate::book::Side,
        taker_owner: u32,
        self_trade_behavior: SelfTradeBehavior,
        taker_price: i64,
        taker_quantity: u64,
        oracle: Option<i64>,
        now: u64,
    ) -> Result<V3MatchPlan, ProgramError> {
        self.plan_crossing_trees(
            &[tree],
            taker_side,
            taker_owner,
            self_trade_behavior,
            taker_price,
            taker_quantity,
            oracle,
            now,
        )
    }

    /// Plans against both fixed and oracle-pegged roots. Candidates are
    /// selected by executable price and a normalized price/time key so a
    /// pegged maker cannot lose FIFO priority merely because its raw offset
    /// lives in a different Patricia root.
    pub fn plan_crossing_cross_tree(
        &mut self,
        taker_side: crate::book::Side,
        taker_owner: u32,
        self_trade_behavior: SelfTradeBehavior,
        taker_price: i64,
        taker_quantity: u64,
        oracle: Option<i64>,
        now: u64,
    ) -> Result<V3MatchPlan, ProgramError> {
        self.plan_crossing_trees(
            &[TreeKind::Fixed, TreeKind::OraclePegged],
            taker_side,
            taker_owner,
            self_trade_behavior,
            taker_price,
            taker_quantity,
            oracle,
            now,
        )
    }

    fn plan_crossing_trees(
        &mut self,
        trees: &[TreeKind],
        taker_side: crate::book::Side,
        taker_owner: u32,
        self_trade_behavior: SelfTradeBehavior,
        taker_price: i64,
        taker_quantity: u64,
        oracle: Option<i64>,
        now: u64,
    ) -> Result<V3MatchPlan, ProgramError> {
        if taker_price <= 0 || taker_quantity == 0 {
            return Err(bundle_error());
        }
        let mut plan = V3MatchPlan {
            fills: [EMPTY_V3_FILL; crate::book::MAX_FILLS_PER_INSTRUCTION],
            fill_count: 0,
            taker_remaining: taker_quantity,
            cancellations: [EMPTY_V3_CANCELLATION; crate::book::MAX_FILLS_PER_INSTRUCTION],
            cancellation_count: 0,
        };
        let mut selected = [NONE; crate::book::MAX_FILLS_PER_INSTRUCTION];
        let mut selected_trees = [0u8; crate::book::MAX_FILLS_PER_INSTRUCTION];
        let mut selected_count = 0usize;
        while selected_count < crate::book::MAX_FILLS_PER_INSTRUCTION && plan.taker_remaining > 0 {
            let index = selected_count;
            let Some((maker_tree, handle, maker_price)) = self.best_unselected_across(
                trees,
                if taker_side == crate::book::Side::Bid {
                    crate::book::Side::Ask
                } else {
                    crate::book::Side::Bid
                },
                oracle,
                now,
                &selected_trees,
                &selected,
                index,
            )?
            else {
                break;
            };
            selected_count += 1;
            selected_trees[index] = maker_tree as u8;
            let leaf = self.leaf(handle)?;
            let expires = unsafe { core::ptr::addr_of!(leaf.expires_at).read_unaligned() };
            if expires <= now {
                selected[index] = handle;
                continue;
            }
            let maker_side = if taker_side == crate::book::Side::Bid {
                crate::book::Side::Ask
            } else {
                crate::book::Side::Bid
            };
            if leaf.side != maker_side as u8 {
                selected[index] = handle;
                continue;
            }
            let crosses = if taker_side == crate::book::Side::Bid {
                maker_price <= taker_price as u64
            } else {
                maker_price >= taker_price as u64
            };
            if !crosses {
                break;
            }
            let maker_quantity = leaf.quantity;
            let fill_quantity = maker_quantity.min(plan.taker_remaining);
            let key = unsafe { core::ptr::addr_of!(leaf.key).read_unaligned() };
            let owner = leaf.owner;
            selected[index] = handle;
            if owner == taker_owner {
                match self_trade_behavior {
                    SelfTradeBehavior::AbortTransaction => {
                        return Err(StockStreamError::SelfTradeAborted.into())
                    }
                    SelfTradeBehavior::DecrementTake => {
                        plan.taker_remaining -= fill_quantity;
                        continue;
                    }
                    SelfTradeBehavior::CancelProvide => {
                        let count = plan.cancellation_count as usize;
                        if count >= plan.cancellations.len() {
                            return Err(StockStreamError::SelfTradeAborted.into());
                        }
                        plan.cancellations[count] = V3SelfTradeCancellation {
                            maker_tree: maker_tree as u8,
                            maker_handle: handle,
                            maker_owner: owner,
                            key,
                            quantity: maker_quantity,
                            price: maker_price,
                            side: leaf.side,
                        };
                        plan.cancellation_count += 1;
                        continue;
                    }
                }
            }
            let fill_index = plan.fill_count as usize;
            plan.fills[fill_index] = V3Fill {
                maker_tree: maker_tree as u8,
                maker_handle: handle,
                maker_owner: owner,
                key,
                price: maker_price,
                quantity: fill_quantity,
                maker_remaining: maker_quantity - fill_quantity,
            };
            selected[index] = handle;
            plan.fill_count += 1;
            plan.taker_remaining -= fill_quantity;
            if fill_quantity < maker_quantity {
                break;
            }
        }
        Ok(plan)
    }

    /// Applies a previously planned set of maker updates only if every key,
    /// owner and quantity still matches. A failed validation performs no
    /// writes, preserving atomic rollback at the instruction boundary.
    pub fn apply_match_plan(&mut self, _tree: TreeKind, plan: &V3MatchPlan) -> ProgramResult {
        for cancel in plan.cancellations[..plan.cancellation_count as usize].iter() {
            let cancel_tree = TreeKind::from_u8(cancel.maker_tree).ok_or_else(bundle_error)?;
            let current = self.leaf(cancel.maker_handle)?;
            let current_key = unsafe { core::ptr::addr_of!(current.key).read_unaligned() };
            if current_key != cancel.key
                || current.owner != cancel.maker_owner
                || current.quantity != cancel.quantity
                || self.find(cancel_tree, cancel.key)? != cancel.maker_handle
            {
                return Err(bundle_error());
            }
        }
        for fill in plan.fills[..plan.fill_count as usize].iter() {
            let fill_tree = TreeKind::from_u8(fill.maker_tree).ok_or_else(bundle_error)?;
            let current = self.leaf(fill.maker_handle)?;
            let current_key = unsafe { core::ptr::addr_of!(current.key).read_unaligned() };
            let current_owner = current.owner;
            let current_quantity = current.quantity;
            if current_key != fill.key
                || current_owner != fill.maker_owner
                || self.find(fill_tree, fill.key)? != fill.maker_handle
                || current_quantity != fill.quantity + fill.maker_remaining
            {
                return Err(bundle_error());
            }
        }
        for cancel in plan.cancellations[..plan.cancellation_count as usize].iter() {
            let cancel_tree = TreeKind::from_u8(cancel.maker_tree).ok_or_else(bundle_error)?;
            self.remove(cancel_tree, cancel.key)?;
        }
        for fill in plan.fills[..plan.fill_count as usize].iter() {
            let fill_tree = TreeKind::from_u8(fill.maker_tree).ok_or_else(bundle_error)?;
            if fill.maker_remaining == 0 {
                self.remove(fill_tree, fill.key)?;
            } else {
                let mut leaf = self.leaf(fill.maker_handle)?;
                leaf.quantity = fill.maker_remaining;
                self.put_leaf(fill.maker_handle, leaf)?;
            }
        }
        Ok(())
    }

    pub fn first_expired(&mut self, tree: TreeKind, now: u64) -> Result<Option<u32>, ProgramError> {
        let mut current = self.root(tree)?;
        while current != NONE {
            match self.tag(current)? {
                TAG_LEAF => {
                    let leaf = self.leaf(current)?;
                    let expires = unsafe { core::ptr::addr_of!(leaf.expires_at).read_unaligned() };
                    return Ok((expires <= now).then_some(current));
                }
                TAG_INNER => {
                    let inner = self.inner(current)?;
                    let expiry = inner.child_earliest_expiry;
                    current = if expiry[0] <= now {
                        inner.children[0]
                    } else if expiry[1] <= now {
                        inner.children[1]
                    } else {
                        NONE
                    };
                }
                _ => return Err(bundle_error()),
            }
        }
        Ok(None)
    }

    pub fn sweep_expired(&mut self, tree: TreeKind, now: u64, max: u8) -> Result<u8, ProgramError> {
        let mut removed = 0;
        while removed < max {
            let Some(handle) = self.first_expired(tree, now)? else {
                break;
            };
            let leaf = self.leaf(handle)?;
            let key = unsafe { core::ptr::addr_of!(leaf.key).read_unaligned() };
            self.remove(tree, key)?;
            removed += 1;
        }
        Ok(removed)
    }
}

/// Initializes the per-side global book metadata after a book-page PDA has
/// reached its final allocation. Only page zero owns roots/free-list/bump
/// state; a fresh all-zero header would otherwise incorrectly treat handle
/// zero as a root.
pub fn initialize_book_page_metadata(data: &mut [u8], page: u8) -> ProgramResult {
    if data.len() != V3_BOOK_PAGE_SIZE || page >= V3_BOOK_PAGES_PER_SIDE as u8 {
        return Err(bundle_error());
    }
    data[44..64].fill(0);
    if page == 0 {
        data[V3_BOOK_FIXED_ROOT_OFFSET..V3_BOOK_FIXED_ROOT_OFFSET + 4]
            .copy_from_slice(&NONE.to_le_bytes());
        data[V3_BOOK_PEGGED_ROOT_OFFSET..V3_BOOK_PEGGED_ROOT_OFFSET + 4]
            .copy_from_slice(&NONE.to_le_bytes());
        data[V3_BOOK_FREE_HEAD_OFFSET..V3_BOOK_FREE_HEAD_OFFSET + 4]
            .copy_from_slice(&NONE.to_le_bytes());
    }
    Ok(())
}

fn validate_event_shard(
    program_id: &Address,
    account: &AccountView,
    core: &Address,
    index: u8,
) -> ProgramResult {
    if !account.owned_by(program_id)
        || !account.is_writable()
        || *account.address() != derive_event_shard_v3(program_id, core, index)
    {
        return Err(bundle_error());
    }
    let bytes = unsafe { account.borrow_unchecked() };
    if bytes.len() != V3_EVENT_SHARD_SIZE
        || bytes[0..8] != V3_EVENT_SHARD_DISCRIMINATOR
        || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != index
        || bytes[11] != 0
        || bytes[12..44] != core.to_bytes()
    {
        return Err(bundle_error());
    }
    Ok(())
}

/// Appends one canonical 100-byte event record to the global four-shard
/// queue. The core sequence is the source of truth; sequence modulo 128 gives
/// a deterministic ring slot and therefore cannot be caller-selected.
pub fn append_event_record(
    program_id: &Address,
    core: &mut AccountView,
    shards: &mut [AccountView],
    kind: u16,
    payload: &[u8; crate::events::EVENT_PAYLOAD_SIZE],
    timestamp: u64,
) -> ProgramResult {
    if shards.len() != V3_EVENT_SHARDS || !core.is_writable() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let core_key = validate_event_core(program_id, core)?;
    for (index, shard) in shards.iter().enumerate() {
        validate_event_shard(program_id, shard, &core_key, index as u8)?;
    }
    let sequence = next_core_event_sequence(core)?;
    let shard_index = (sequence as usize / V3_EVENTS_PER_SHARD) % V3_EVENT_SHARDS;
    let slot = sequence as usize % V3_EVENTS_PER_SHARD;
    let mut record = [0u8; V3_EVENT_RECORD_SIZE];
    record[0..2].copy_from_slice(&kind.to_le_bytes());
    record[2] = crate::events::EVENT_ABI_VERSION;
    record[4..12].copy_from_slice(&sequence.to_le_bytes());
    record[12..44].copy_from_slice(core_key.as_ref());
    record[44..52].copy_from_slice(&timestamp.to_le_bytes());
    record[52..].copy_from_slice(payload);
    let mut bytes = unsafe { shards[shard_index].borrow_unchecked_mut() };
    let offset = V3_SHARD_HEADER_SIZE + slot * V3_EVENT_RECORD_SIZE;
    bytes[offset..offset + V3_EVENT_RECORD_SIZE].copy_from_slice(&record);
    Ok(())
}

/// Applies a funding accumulator update to the bounded V3 bundle. The mark is
/// recomputed from the same page-sharded PATRICIA roots used by matching; the
/// caller can only provide a monotonic timestamp and accumulator bounded by
/// the elapsed-second cap and the mark/index basis.
pub fn update_funding_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction: StockStreamInstruction,
) -> ProgramResult {
    if accounts.len() != V3_SIGNER_ACCOUNT_INDEX + 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_execution_bundle(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN], true)?;
    let StockStreamInstruction::UpdateFunding {
        accumulator,
        timestamp,
    } = instruction
    else {
        return Err(ProgramError::InvalidInstructionData);
    };
    let signer = &accounts[V3_SIGNER_ACCOUNT_INDEX];
    if !signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    {
        let core = unsafe { accounts[0].borrow_unchecked() };
        if core[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != signer.address().to_bytes()
            || core[V3_CORE_ORACLE_VALID_OFFSET] != 1
            || !matches!(core[V3_CORE_MODE_OFFSET], 1..=3)
        {
            return Err(StockStreamError::OracleUnavailable.into());
        }
    }
    let (bundle, _) = accounts.split_at_mut(V3_EXECUTION_BUNDLE_LEN);
    let oracle = {
        let core = unsafe { bundle[0].borrow_unchecked() };
        i64::from_le_bytes(
            core[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
                .try_into()
                .map_err(|_| bundle_error())?,
        )
    };
    if oracle <= 0 {
        return Err(StockStreamError::OracleUnavailable.into());
    }
    let mark_deviation_bps = {
        let core = unsafe { bundle[0].borrow_unchecked() };
        read_v3_risk_config(&core)?.mark_deviation_bps
    };
    let now = {
        let core = unsafe { bundle[0].borrow_unchecked() };
        u64::from_le_bytes(
            core[V3_CORE_ORACLE_TIMESTAMP_OFFSET..V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
                .try_into()
                .map_err(|_| bundle_error())?,
        )
    };
    let best_for = |book: &mut PagedBookV3<'_>, side: Side| -> Result<Option<i64>, ProgramError> {
        let mut best: Option<i64> = None;
        for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
            if let Some(price) = book.best_executable_price(tree, side, oracle, now)? {
                best = Some(match (best, side) {
                    (None, _) => price,
                    (Some(current), Side::Bid) => current.max(price),
                    (Some(current), Side::Ask) => current.min(price),
                });
            }
        }
        Ok(best)
    };
    let best_bid = {
        let mut book = PagedBookV3::new(&mut bundle[1..1 + V3_BOOK_PAGES_PER_SIDE])?;
        best_for(&mut book, Side::Bid)?
    };
    let best_ask = {
        let start = 1 + V3_BOOK_PAGES_PER_SIDE;
        let mut book = PagedBookV3::new(&mut bundle[start..start + V3_BOOK_PAGES_PER_SIDE])?;
        best_for(&mut book, Side::Ask)?
    };
    let mark = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) if ask > bid => (i128::from(bid) + i128::from(ask)) / 2,
        (Some(bid), None) => i128::from(bid),
        (None, Some(ask)) => i128::from(ask),
        _ => i128::from(oracle),
    };
    // A zero mark-deviation field retains the historical 500 bps default;
    // configured V3 risk values otherwise control the clamp deterministically.
    let deviation_bps = if mark_deviation_bps == 0 {
        500
    } else {
        i128::from(mark_deviation_bps)
    };
    let max_deviation = i128::from(oracle)
        .checked_mul(deviation_bps)
        .and_then(|value| value.checked_div(10_000))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let lower = (i128::from(oracle) - max_deviation).max(1);
    let upper = i128::from(oracle)
        .checked_add(max_deviation)
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let mark = mark.max(lower).min(upper);
    let (previous_accumulator, previous_timestamp) = {
        let core = unsafe { bundle[0].borrow_unchecked() };
        (
            i128::from_le_bytes(
                core[V3_CORE_FUNDING_ACCUMULATOR_OFFSET..V3_CORE_FUNDING_ACCUMULATOR_OFFSET + 16]
                    .try_into()
                    .map_err(|_| bundle_error())?,
            ),
            u64::from_le_bytes(
                core[V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET
                    ..V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET + 8]
                    .try_into()
                    .map_err(|_| bundle_error())?,
            ),
        )
    };
    if timestamp < previous_timestamp || accumulator < previous_accumulator {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let basis_bps = mark
        .checked_sub(i128::from(oracle))
        .and_then(|value| value.checked_mul(10_000))
        .and_then(|value| value.checked_div(i128::from(oracle)))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let elapsed = timestamp.saturating_sub(previous_timestamp);
    let cap = i128::from(elapsed)
        .checked_mul(1)
        .ok_or(StockStreamError::ArithmeticOverflow)?
        .min(basis_bps.abs());
    let requested = accumulator
        .checked_sub(previous_accumulator)
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    if requested.abs() > cap {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    {
        let core = unsafe { bundle[0].borrow_unchecked_mut() };
        core[V3_CORE_FUNDING_ACCUMULATOR_OFFSET..V3_CORE_FUNDING_ACCUMULATOR_OFFSET + 16]
            .copy_from_slice(&accumulator.to_le_bytes());
        core[V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET..V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET + 8]
            .copy_from_slice(&timestamp.to_le_bytes());
    }
    let payload = crate::events::payload_funding(crate::events::NO_SEAT, accumulator, 0);
    let event_start = 1 + (2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS;
    let (core_prefix, event_accounts) = bundle.split_at_mut(event_start);
    append_event_record(
        program_id,
        &mut core_prefix[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::FundingAccumulatorUpdated as u16,
        &payload,
        timestamp,
    )?;
    Ok(())
}

fn bundle_error() -> ProgramError {
    StockStreamError::InvalidInstruction.into()
}

fn v3_risk_error(error: crate::risk::RiskError) -> ProgramError {
    match error {
        crate::risk::RiskError::Overflow => StockStreamError::ArithmeticOverflow.into(),
        crate::risk::RiskError::InvalidPrice => StockStreamError::InvalidInstruction.into(),
        crate::risk::RiskError::NegativeCollateral
        | crate::risk::RiskError::PositionLimit
        | crate::risk::RiskError::OpenInterestLimit
        | crate::risk::RiskError::Margin => StockStreamError::RiskViolation.into(),
    }
}

/// Validates the exact account order required by future V3 trading handlers:
/// `[core, book(side 0/page 0..8), book(side 1/page 0..8), seat(0..3),
/// event(0..3)]`. No handler may accept caller-selected page ordering or a
/// partial bundle, since that would make cross-page PATRICIA traversal and
/// atomic matching ambiguous. `require_writable` is true for mutations and
/// false for read-only aggregation/preflight paths.
pub fn validate_execution_bundle(
    program_id: &Address,
    accounts: &[AccountView],
    require_writable: bool,
) -> ProgramResult {
    if accounts.len() != V3_EXECUTION_BUNDLE_LEN {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for (index, account) in accounts.iter().enumerate() {
        if !account.owned_by(program_id) || (require_writable && !account.is_writable()) {
            return Err(bundle_error());
        }
        if accounts[..index]
            .iter()
            .any(|other| other.address() == account.address())
        {
            return Err(bundle_error());
        }
    }
    let core = &accounts[0];
    let core_bytes = unsafe { core.borrow_unchecked() };
    if core_bytes.len() != V3_MARKET_CORE_SIZE
        || core_bytes[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || core_bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || core_bytes[10] != 1
        || core_bytes[V3_CORE_MODE_OFFSET] > 2
    {
        return Err(bundle_error());
    }
    // A V2 market (wrong size/discriminator) cannot reach this point. A V3
    // delegated core is deliberately rejected here too: these program-owned
    // account views are only valid on the appropriate execution domain.
    if core_bytes[V3_CORE_DELEGATION_STATUS_OFFSET] > DelegationStatus::Restored as u8 {
        return Err(bundle_error());
    }
    if core_bytes[V3_CORE_COMMIT_PHASE_OFFSET] != V3_COMMIT_PHASE_IDLE {
        return Err(StockStreamError::MagicBlockUndelegationInProgress.into());
    }
    let core_key = *core.address();
    let book_account_count = 2 * V3_BOOK_PAGES_PER_SIDE;
    for flat in 0..book_account_count {
        let account = &accounts[1 + flat];
        let side = (flat / V3_BOOK_PAGES_PER_SIDE) as u8;
        let page = (flat % V3_BOOK_PAGES_PER_SIDE) as u8;
        if *account.address() != derive_book_page_v3(program_id, &core_key, side, page) {
            return Err(bundle_error());
        }
        let bytes = unsafe { account.borrow_unchecked() };
        if bytes.len() != V3_BOOK_PAGE_SIZE
            || bytes[0..8] != V3_BOOK_PAGE_DISCRIMINATOR
            || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
            || bytes[10] != side
            || bytes[11] != page
            || bytes[12..44] != core_key.to_bytes()
            || (page == 0
                && (u32::from_le_bytes(bytes[56..60].try_into().unwrap())
                    > V3_BOOK_SLOTS_PER_SIDE as u32
                    || u32::from_le_bytes(bytes[60..64].try_into().unwrap())
                        > V3_BOOK_SLOTS_PER_SIDE as u32))
            || (page != 0 && bytes[44..64].iter().any(|value| *value != 0))
        {
            return Err(bundle_error());
        }
    }
    for shard in 0..V3_SEAT_SHARDS {
        let account = &accounts[1 + book_account_count + shard];
        if *account.address() != derive_seat_shard_v3(program_id, &core_key, shard as u8) {
            return Err(bundle_error());
        }
        let bytes = unsafe { account.borrow_unchecked() };
        if bytes.len() != V3_SEAT_SHARD_SIZE
            || bytes[0..8] != V3_SEAT_SHARD_DISCRIMINATOR
            || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
            || bytes[10] != shard as u8
            || bytes[11] != 0
            || bytes[12..44] != core_key.to_bytes()
        {
            return Err(bundle_error());
        }
    }
    for shard in 0..V3_EVENT_SHARDS {
        let account = &accounts[1 + book_account_count + V3_SEAT_SHARDS + shard];
        if *account.address() != derive_event_shard_v3(program_id, &core_key, shard as u8) {
            return Err(bundle_error());
        }
        let bytes = unsafe { account.borrow_unchecked() };
        if bytes.len() != V3_EVENT_SHARD_SIZE
            || bytes[0..8] != V3_EVENT_SHARD_DISCRIMINATOR
            || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
            || bytes[10] != shard as u8
            || bytes[11] != 0
            || bytes[12..44] != core_key.to_bytes()
        {
            return Err(bundle_error());
        }
    }
    Ok(())
}

/// L1 custody may release collateral only after every execution shard has
/// returned and the core's commit cursor is reconciled. The vault remains a
/// separate L1 account and is never part of the delegated execution bundle.
pub fn validate_v3_withdrawal_readiness(
    program_id: &Address,
    accounts: &[AccountView],
) -> ProgramResult {
    validate_execution_bundle(program_id, accounts, false)?;
    let core = unsafe { accounts[0].borrow_unchecked() };
    if core[V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::Restored as u8 {
        return Err(StockStreamError::CustodyViolation.into());
    }
    let expected = u64::from_le_bytes(
        core[V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET..V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    let committed = u64::from_le_bytes(
        core[V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET..V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    if expected != committed {
        return Err(StockStreamError::CustodyViolation.into());
    }
    Ok(())
}

/// The result of validating a V3 session signer against the sharded seat
/// domain.  The caller must consume the returned session nonce only after its
/// complete state transition succeeds.
#[derive(Clone, Copy)]
pub struct V3SessionAuthorization {
    pub session: TradingSession,
    pub seat: TraderSeat,
}

/// Validates a scoped session action for a V3 seat.  This is deliberately
/// separate from the legacy V2 handler helper: V3 seats are spread across
/// four PDAs, and accepting a caller-selected shard would permit an account
/// substitution between authorization and settlement.
#[allow(clippy::too_many_arguments)]
pub fn validate_v3_session_actor(
    program_id: &Address,
    core: &AccountView,
    seat_shards: &[AccountView],
    session_account: &AccountView,
    signer_account: &AccountView,
    seat_index: u16,
    required_actions: u8,
    notional: i128,
    resulting_exposure: u128,
    resulting_open_orders: u32,
    action_nonce: u64,
    now: u64,
) -> Result<V3SessionAuthorization, ProgramError> {
    if seat_shards.len() != V3_SEAT_SHARDS || !signer_account.is_signer() || required_actions == 0 {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let core_key = *core.address();
    let core_bytes = unsafe { core.borrow_unchecked() };
    if !core.owned_by(program_id)
        || core_bytes.len() != V3_MARKET_CORE_SIZE
        || core_bytes[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || core_bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || core_bytes[10] != 1
        || core_bytes[V3_CORE_MODE_OFFSET] != 1
    {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    for (shard, account) in seat_shards.iter().enumerate() {
        if !account.owned_by(program_id)
            || *account.address() != derive_seat_shard_v3(program_id, &core_key, shard as u8)
        {
            return Err(StockStreamError::InvalidTradingSession.into());
        }
        let bytes = unsafe { account.borrow_unchecked() };
        if bytes.len() != V3_SEAT_SHARD_SIZE
            || bytes[0..8] != V3_SEAT_SHARD_DISCRIMINATOR
            || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
            || bytes[10] != shard as u8
            || bytes[11] != 0
            || bytes[12..44] != core_key.to_bytes()
        {
            return Err(StockStreamError::InvalidTradingSession.into());
        }
    }
    let index = seat_index as usize;
    if index >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let shard = index / V3_SEATS_PER_SHARD;
    let slot = index % V3_SEATS_PER_SHARD;
    let seat_bytes = unsafe { seat_shards[shard].borrow_unchecked() };
    let seat = read_shard_seat(seat_bytes, slot)?;
    if seat.occupancy != 1 || seat.trader == [0; 32] {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let owner = Address::new_from_array(seat.trader);
    let signer = *signer_account.address();
    if owner == signer {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let session_state = session::validated_session_account(
        program_id,
        session_account,
        &owner,
        &core_key,
        seat_index,
        &signer,
        true,
    )?;
    if !session_state.is_live(now) || session_state.actions & required_actions == 0 {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    if action_nonce != session_state.next_expected_nonce {
        return Err(StockStreamError::SessionNonceReplay.into());
    }
    if session_state.next_expected_nonce == u64::MAX {
        return Err(StockStreamError::ArithmeticOverflow.into());
    }
    if notional < 0
        || notional as u128 > session_state.max_order_notional as u128
        || (notional as u128).saturating_add(session_state.consumed_cumulative_notional as u128)
            > session_state.max_cumulative_notional as u128
        || resulting_exposure > session_state.max_exposure as u128
        || resulting_open_orders > u32::from(session_state.max_open_orders)
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    Ok(V3SessionAuthorization {
        session: session_state,
        seat,
    })
}

fn validate_active_core(program_id: &Address, core: &AccountView) -> Result<Address, ProgramError> {
    if !core.owned_by(program_id) || !core.is_writable() {
        return Err(bundle_error());
    }
    let bytes = unsafe { core.borrow_unchecked() };
    if bytes.len() != V3_MARKET_CORE_SIZE
        || bytes[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != 1
        || bytes[V3_CORE_MODE_OFFSET] != 1
        || bytes[V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::NotDelegated as u8
        || bytes[V3_CORE_COMMIT_PHASE_OFFSET] != V3_COMMIT_PHASE_IDLE
    {
        return Err(bundle_error());
    }
    Ok(*core.address())
}

fn validate_event_core(program_id: &Address, core: &AccountView) -> Result<Address, ProgramError> {
    if !core.owned_by(program_id) || !core.is_writable() {
        return Err(bundle_error());
    }
    let bytes = unsafe { core.borrow_unchecked() };
    if bytes.len() != V3_MARKET_CORE_SIZE
        || bytes[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != 1
        || bytes[V3_CORE_MODE_OFFSET] != 1
        || bytes[V3_CORE_DELEGATION_STATUS_OFFSET] == DelegationStatus::Undelegating as u8
        || bytes[V3_CORE_COMMIT_PHASE_OFFSET] == V3_COMMIT_PHASE_UNDELEGATING
    {
        return Err(bundle_error());
    }
    Ok(*core.address())
}

fn validate_seat_shard(
    program_id: &Address,
    account: &AccountView,
    core: &Address,
    index: u8,
) -> ProgramResult {
    if !account.owned_by(program_id)
        || !account.is_writable()
        || *account.address() != derive_seat_shard_v3(program_id, core, index)
    {
        return Err(bundle_error());
    }
    let bytes = unsafe { account.borrow_unchecked() };
    if bytes.len() != V3_SEAT_SHARD_SIZE
        || bytes[0..8] != V3_SEAT_SHARD_DISCRIMINATOR
        || bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != index
        || bytes[11] != 0
        || bytes[12..44] != core.to_bytes()
    {
        return Err(bundle_error());
    }
    Ok(())
}

pub(crate) fn read_shard_seat(bytes: &[u8], slot: usize) -> Result<TraderSeat, ProgramError> {
    if slot >= V3_SEATS_PER_SHARD {
        return Err(bundle_error());
    }
    let start = V3_SHARD_HEADER_SIZE + slot * TRADER_SEAT_SIZE;
    let end = start + TRADER_SEAT_SIZE;
    if end > bytes.len() {
        return Err(bundle_error());
    }
    let mut seat = MaybeUninit::<TraderSeat>::uninit();
    unsafe {
        ptr::copy_nonoverlapping(
            bytes.as_ptr().add(start),
            seat.as_mut_ptr().cast::<u8>(),
            TRADER_SEAT_SIZE,
        );
        Ok(seat.assume_init())
    }
}

pub(crate) fn write_shard_seat(bytes: &mut [u8], slot: usize, seat: &TraderSeat) -> ProgramResult {
    if slot >= V3_SEATS_PER_SHARD {
        return Err(bundle_error());
    }
    let start = V3_SHARD_HEADER_SIZE + slot * TRADER_SEAT_SIZE;
    if start + TRADER_SEAT_SIZE > bytes.len() {
        return Err(bundle_error());
    }
    unsafe {
        ptr::copy_nonoverlapping(
            seat as *const TraderSeat as *const u8,
            bytes.as_mut_ptr().add(start),
            TRADER_SEAT_SIZE,
        );
    }
    Ok(())
}

fn next_core_event_sequence(core: &mut AccountView) -> Result<u64, ProgramError> {
    let bytes = unsafe { core.borrow_unchecked_mut() };
    let current = u64::from_le_bytes(
        bytes[V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET..V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    let next = current
        .checked_add(1)
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    bytes[V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET..V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET + 8]
        .copy_from_slice(&next.to_le_bytes());
    Ok(current)
}

/// Opcode 49. Accounts are `[core(write), seat_shard_0..3(write),
/// event_shard_0..3(write), trader(signer)]`.
/// All execution shards are present so seat mutation and its durable event are
/// one validated atomic account set.
pub fn create_trader_seat(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    if accounts.len() != 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[9].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let core_key = validate_active_core(program_id, &accounts[0])?;
    for shard in 0..V3_SEAT_SHARDS {
        validate_seat_shard(program_id, &accounts[1 + shard], &core_key, shard as u8)?;
        validate_event_shard(program_id, &accounts[5 + shard], &core_key, shard as u8)?;
    }
    let index = seat_index as usize;
    if index >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let trader = accounts[9].address().to_bytes();
    for shard in 0..V3_SEAT_SHARDS {
        let bytes = unsafe { accounts[1 + shard].borrow_unchecked() };
        for slot in 0..V3_SEATS_PER_SHARD {
            let seat = read_shard_seat(bytes, slot)?;
            if !seat.is_empty() && seat.trader == trader {
                return Err(StockStreamError::SeatOccupied.into());
            }
        }
    }
    let shard = index / V3_SEATS_PER_SHARD;
    let slot = index % V3_SEATS_PER_SHARD;
    let core_bytes = unsafe { accounts[0].borrow_unchecked() };
    let sequence = u64::from_le_bytes(
        core_bytes[V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET..V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    {
        let mut target = unsafe { accounts[1 + shard].borrow_unchecked_mut() };
        if !read_shard_seat(&target, slot)?.is_empty() {
            return Err(StockStreamError::SeatOccupied.into());
        }
        let mut seat = TraderSeat::empty();
        seat.occupancy = 1;
        seat.trader = trader;
        seat.sequence = sequence;
        seat.liquidation_state = LiquidationState::Healthy as u8;
        write_shard_seat(&mut target, slot, &seat)?;
    }
    let payload = crate::events::payload_seat(seat_index);
    let (core_accounts, rest) = accounts.split_at_mut(1);
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut rest[4..8],
        crate::events::EventKind::TraderSeatCreated as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// V3 session authorization uses the same TradingSession account format as
/// the legacy market, but binds it to the complete sharded execution bundle.
/// Accounts are `[core, 18 book pages, 4 seat shards, 4 event shards,
/// owner(signer,writable), session PDA(writable), session signer,
/// system program]`.  Requiring the bundle here prevents a session from being
/// authorized against one seat-shard view and later traded against another.
#[allow(clippy::too_many_arguments)]
pub fn authorize_trading_session_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> ProgramResult {
    if accounts.len() != V3_EXECUTION_BUNDLE_LEN + 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_execution_bundle(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN], true)?;
    let owner = &accounts[V3_EXECUTION_BUNDLE_LEN];
    let session_account = &accounts[V3_EXECUTION_BUNDLE_LEN + 1];
    let session_signer = &accounts[V3_EXECUTION_BUNDLE_LEN + 2];
    if !owner.is_signer()
        || !owner.is_writable()
        || !session_account.is_writable()
        || *accounts[V3_EXECUTION_BUNDLE_LEN + 3].address() != pinocchio_system::ID
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if owner.address() == session_signer.address() || owner.address() == accounts[0].address() {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let seat = v3_trade_seat(&accounts[..V3_EXECUTION_BUNDLE_LEN], seat_index)?.0;
    if seat.trader != owner.address().to_bytes() {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let core_snapshot = unsafe { accounts[0].borrow_unchecked() };
    let now = u64::from_le_bytes(
        core_snapshot[V3_CORE_ORACLE_TIMESTAMP_OFFSET..V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    if core_snapshot[V3_CORE_ORACLE_VALID_OFFSET] != 1
        || expires_at <= now
        || actions == 0
        || max_order_notional == 0
        || max_cumulative_notional < max_order_notional
        || maximum_exposure <= 0
        || maximum_open_orders == 0
    {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let core_key = *accounts[0].address();
    let signer_key = *session_signer.address();
    let (expected_pda, bump) = Address::find_program_address(
        &[
            session::TRADING_SESSION_SEED,
            owner.address().as_ref(),
            core_key.as_ref(),
            &seat_index.to_le_bytes(),
            signer_key.as_ref(),
        ],
        program_id,
    );
    if expected_pda != *session_account.address()
        || session_account.lamports() != 0
        || session_account.owned_by(program_id)
        || session_account.address() == owner.address()
    {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let bump_bytes = [bump];
    let seat_bytes = seat_index.to_le_bytes();
    let seeds = [
        Seed::from(session::TRADING_SESSION_SEED),
        Seed::from(owner.address().as_ref()),
        Seed::from(core_key.as_ref()),
        Seed::from(&seat_bytes),
        Seed::from(signer_key.as_ref()),
        Seed::from(&bump_bytes),
    ];
    let signer = Signer::from(&seeds);
    let rent = Rent::get()?;
    pinocchio_system::instructions::CreateAccount {
        from: owner,
        to: session_account,
        lamports: rent.try_minimum_balance(session::TRADING_SESSION_SIZE)?,
        space: session::TRADING_SESSION_SIZE as u64,
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(&signer))?;
    let mut state = TradingSession::empty();
    state.initialized = 1;
    state.owner = owner.address().to_bytes();
    state.session_signer = signer_key.to_bytes();
    state.target_program = program_id.to_bytes();
    state.market = core_key.to_bytes();
    state.trader_seat_index = seat_index;
    state.created_at = now;
    state.expires_at = expires_at;
    state.actions = actions;
    state.max_order_notional = max_order_notional;
    state.max_cumulative_notional = max_cumulative_notional;
    state.max_exposure = maximum_exposure;
    state.max_open_orders = maximum_open_orders;
    session::write_session(
        unsafe { accounts[V3_EXECUTION_BUNDLE_LEN + 1].borrow_unchecked_mut() },
        &state,
    )?;
    let payload = crate::events::payload_session(seat_index, &signer_key.to_bytes(), 0);
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (_, event_accounts) = tail.split_at_mut((2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS);
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::TradingSessionAuthorized as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

fn validate_v3_session_control(
    program_id: &Address,
    accounts: &[AccountView],
    seat_index: u16,
) -> Result<(Address, Address, Address, TradingSession), ProgramError> {
    if accounts.len() != V3_EXECUTION_BUNDLE_LEN + 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_execution_bundle(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN], true)?;
    let owner = &accounts[V3_EXECUTION_BUNDLE_LEN];
    let session_account = &accounts[V3_EXECUTION_BUNDLE_LEN + 1];
    let session_signer = &accounts[V3_EXECUTION_BUNDLE_LEN + 2];
    if !owner.is_signer() || !session_account.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let core = *accounts[0].address();
    let signer = *session_signer.address();
    let state = session::validated_session_account(
        program_id,
        session_account,
        owner.address(),
        &core,
        seat_index,
        &signer,
        true,
    )?;
    Ok((*owner.address(), core, signer, state))
}

/// Revokes a V3 session and records the event in the same sharded bundle used
/// for trading. Accounts are `[execution bundle, owner, session, signer]`.
pub fn revoke_trading_session_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    let (owner, core, signer, mut state) =
        validate_v3_session_control(program_id, accounts, seat_index)?;
    state.revoked = 1;
    session::write_session(
        unsafe { accounts[V3_EXECUTION_BUNDLE_LEN + 1].borrow_unchecked_mut() },
        &state,
    )?;
    let payload = crate::events::payload_session(seat_index, &signer.to_bytes(), 0);
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (_, event_accounts) = tail.split_at_mut((2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS);
    let _ = owner;
    let _ = core;
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::TradingSessionRevoked as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// Updates V3 session limits without allowing the session signer to update
/// itself. The owner and complete execution bundle remain mandatory.
#[allow(clippy::too_many_arguments)]
pub fn update_trading_session_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    expires_at: u64,
    actions: u8,
    max_order_notional: u64,
    max_cumulative_notional: u64,
    maximum_exposure: i128,
    maximum_open_orders: u16,
) -> ProgramResult {
    let (owner, _core, signer, mut state) =
        validate_v3_session_control(program_id, accounts, seat_index)?;
    if state.revoked == 1
        || expires_at <= state.created_at
        || actions == 0
        || max_order_notional == 0
        || max_cumulative_notional < max_order_notional
        || maximum_exposure <= 0
        || maximum_open_orders == 0
        || max_cumulative_notional < state.consumed_cumulative_notional
    {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    state.expires_at = expires_at;
    state.actions = actions;
    state.max_order_notional = max_order_notional;
    state.max_cumulative_notional = max_cumulative_notional;
    state.max_exposure = maximum_exposure;
    state.max_open_orders = maximum_open_orders;
    state.session_generation = state
        .session_generation
        .checked_add(1)
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    session::write_session(
        unsafe { accounts[V3_EXECUTION_BUNDLE_LEN + 1].borrow_unchecked_mut() },
        &state,
    )?;
    let payload = crate::events::payload_session(
        seat_index,
        &signer.to_bytes(),
        state.session_generation.into(),
    );
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (_, event_accounts) = tail.split_at_mut((2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS);
    let _ = owner;
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::TradingSessionLimitsUpdated as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// Closes an expired/revoked V3 session and refunds its rent to the owner.
pub fn close_trading_session_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    let (owner, _core, signer, state) =
        validate_v3_session_control(program_id, accounts, seat_index)?;
    let now = u64::from_le_bytes(
        unsafe { accounts[0].borrow_unchecked() }
            [V3_CORE_ORACLE_TIMESTAMP_OFFSET..V3_CORE_ORACLE_TIMESTAMP_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    if state.revoked == 0 && state.expires_at > now {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let refund = accounts[V3_EXECUTION_BUNDLE_LEN + 1].lamports();
    accounts[V3_EXECUTION_BUNDLE_LEN + 1].set_lamports(0);
    accounts[V3_EXECUTION_BUNDLE_LEN].set_lamports(
        accounts[V3_EXECUTION_BUNDLE_LEN]
            .lamports()
            .checked_add(refund)
            .ok_or(StockStreamError::ArithmeticOverflow)?,
    );
    unsafe { accounts[V3_EXECUTION_BUNDLE_LEN + 1].borrow_unchecked_mut() }.fill(0);
    let payload = crate::events::payload_session(seat_index, &signer.to_bytes(), 0);
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (_, event_accounts) = tail.split_at_mut((2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS);
    let _ = owner;
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::TradingSessionClosed as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// Opcode 50. Accounts are `[core(write), seat_shard_0..3(write),
/// event_shard_0..3(write), trader(signer)]`.
/// All shards stay mandatory: besides fixing the account ABI, it keeps close
/// and create under the same globally validated V3 seat domain.
pub fn close_trader_seat(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
) -> ProgramResult {
    if accounts.len() != 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[9].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let core_key = validate_active_core(program_id, &accounts[0])?;
    for shard in 0..V3_SEAT_SHARDS {
        validate_seat_shard(program_id, &accounts[1 + shard], &core_key, shard as u8)?;
        validate_event_shard(program_id, &accounts[5 + shard], &core_key, shard as u8)?;
    }
    let index = seat_index as usize;
    if index >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let shard = index / V3_SEATS_PER_SHARD;
    let slot = index % V3_SEATS_PER_SHARD;
    let trader = accounts[9].address().to_bytes();
    {
        let mut target = unsafe { accounts[1 + shard].borrow_unchecked_mut() };
        let seat = read_shard_seat(&target, slot)?;
        if seat.trader != trader {
            return Err(StockStreamError::InvalidSeat.into());
        }
        if !seat.can_close() {
            return Err(StockStreamError::SeatNotEmpty.into());
        }
        write_shard_seat(&mut target, slot, &TraderSeat::empty())?;
    }
    let payload = crate::events::payload_seat(seat_index);
    let (core_accounts, rest) = accounts.split_at_mut(1);
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut rest[4..8],
        crate::events::EventKind::TraderSeatClosed as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

fn core_u64(bytes: &[u8], offset: usize) -> Result<u64, ProgramError> {
    bytes
        .get(offset..offset + 8)
        .ok_or_else(bundle_error)
        .and_then(|raw| raw.try_into().map_err(|_| bundle_error()))
        .map(u64::from_le_bytes)
}

fn set_core_u64(bytes: &mut [u8], offset: usize, value: u64) -> ProgramResult {
    let target = bytes.get_mut(offset..offset + 8).ok_or_else(bundle_error)?;
    target.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn core_i128(bytes: &[u8], offset: usize) -> Result<i128, ProgramError> {
    bytes
        .get(offset..offset + 16)
        .ok_or_else(bundle_error)
        .and_then(|raw| raw.try_into().map_err(|_| bundle_error()))
        .map(i128::from_le_bytes)
}

fn set_core_i128(bytes: &mut [u8], offset: usize, value: i128) -> ProgramResult {
    let target = bytes
        .get_mut(offset..offset + 16)
        .ok_or_else(bundle_error)?;
    target.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

/// Produces a bounded, deterministic digest for a committed child account.
/// The digest is deliberately computed without heap allocation or a crypto
/// dependency; it detects mixed/partial snapshots inside the protocol's
/// trusted program boundary and is paired with the exact epoch/sequence.
pub fn snapshot_digest(bytes: &[u8]) -> [u8; 32] {
    let mut lanes = [
        0xcbf29ce484222325u64,
        0x84222325cbf29ce4u64,
        0x9e3779b185ebca87u64,
        0xd6e8feb86659fd93u64,
    ];
    for (index, byte) in bytes.iter().enumerate() {
        for (lane, value) in lanes.iter_mut().enumerate() {
            *value ^= u64::from(*byte).wrapping_add((index as u64) << (lane + 1));
            *value = value.wrapping_mul(0x100000001b3u64 ^ ((lane as u64) << 32));
            *value = value.rotate_left((7 + lane * 11) as u32);
        }
    }
    let mut out = [0u8; 32];
    for (lane, value) in lanes.iter().enumerate() {
        out[lane * 8..lane * 8 + 8].copy_from_slice(&value.to_le_bytes());
    }
    out
}

pub const fn child_record_offset(index: usize) -> Option<usize> {
    if index < V3_CHILD_COUNT {
        Some(V3_CORE_CHILD_RECORDS_OFFSET + index * V3_CORE_CHILD_RECORD_SIZE)
    } else {
        None
    }
}

pub fn read_v3_risk_config(bytes: &[u8]) -> Result<V3RiskConfig, ProgramError> {
    if bytes.len() != V3_MARKET_CORE_SIZE {
        return Err(bundle_error());
    }
    let configured = bytes[V3_CORE_RISK_CONFIG_VERSION_OFFSET] == V3_RISK_CONFIG_VERSION;
    let defaults = V3RiskConfig::defaults();
    let read_u16_or = |offset: usize, fallback: u16| {
        let value = u16::from_le_bytes(
            bytes[offset..offset + 2]
                .try_into()
                .unwrap_or(fallback.to_le_bytes()),
        );
        if configured && value != 0 {
            value
        } else {
            fallback
        }
    };
    let read_u32_or = |offset: usize, fallback: u32| {
        let value = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .unwrap_or(fallback.to_le_bytes()),
        );
        if configured && value != 0 {
            value
        } else {
            fallback
        }
    };
    let config = V3RiskConfig {
        initial_margin_bps: read_u16_or(
            V3_CORE_INITIAL_MARGIN_BPS_OFFSET,
            defaults.initial_margin_bps,
        ),
        maintenance_margin_bps: read_u16_or(
            V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET,
            defaults.maintenance_margin_bps,
        ),
        liquidation_fee_bps: read_u16_or(
            V3_CORE_LIQUIDATION_FEE_BPS_OFFSET,
            defaults.liquidation_fee_bps,
        ),
        maker_fee_bps: read_u16_or(V3_CORE_MAKER_FEE_BPS_OFFSET, defaults.maker_fee_bps),
        taker_fee_bps: read_u16_or(V3_CORE_TAKER_FEE_BPS_OFFSET, defaults.taker_fee_bps),
        maximum_leverage: read_u32_or(V3_CORE_MAXIMUM_LEVERAGE_OFFSET, defaults.maximum_leverage),
        maximum_position: if configured {
            core_i128(bytes, V3_CORE_MAXIMUM_POSITION_OFFSET)?
        } else {
            defaults.maximum_position
        },
        maximum_open_interest: if configured {
            core_i128(bytes, V3_CORE_MAXIMUM_OPEN_INTEREST_OFFSET)?
        } else {
            defaults.maximum_open_interest
        },
        mark_deviation_bps: if configured {
            read_u16_or(
                V3_CORE_MARK_DEVIATION_BPS_OFFSET,
                defaults.mark_deviation_bps,
            )
        } else {
            defaults.mark_deviation_bps
        },
    };
    if config.initial_margin_bps == 0
        || config.maintenance_margin_bps == 0
        || config.maintenance_margin_bps > config.initial_margin_bps
        || config.maximum_leverage == 0
        || config.maker_fee_bps > 1_000
        || config.taker_fee_bps > 1_000
        || config.liquidation_fee_bps > 1_000
        || config.mark_deviation_bps > 10_000
        || config.maximum_position < 0
        || config.maximum_open_interest < 0
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    Ok(config)
}

pub fn initialize_v3_risk_config(bytes: &mut [u8]) -> ProgramResult {
    if bytes.len() != V3_MARKET_CORE_SIZE {
        return Err(bundle_error());
    }
    let config = V3RiskConfig::defaults();
    bytes[V3_CORE_INITIAL_MARGIN_BPS_OFFSET..V3_CORE_INITIAL_MARGIN_BPS_OFFSET + 2]
        .copy_from_slice(&config.initial_margin_bps.to_le_bytes());
    bytes[V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET..V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET + 2]
        .copy_from_slice(&config.maintenance_margin_bps.to_le_bytes());
    bytes[V3_CORE_LIQUIDATION_FEE_BPS_OFFSET..V3_CORE_LIQUIDATION_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.liquidation_fee_bps.to_le_bytes());
    bytes[V3_CORE_MAKER_FEE_BPS_OFFSET..V3_CORE_MAKER_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.maker_fee_bps.to_le_bytes());
    bytes[V3_CORE_TAKER_FEE_BPS_OFFSET..V3_CORE_TAKER_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.taker_fee_bps.to_le_bytes());
    bytes[V3_CORE_MAXIMUM_LEVERAGE_OFFSET..V3_CORE_MAXIMUM_LEVERAGE_OFFSET + 4]
        .copy_from_slice(&config.maximum_leverage.to_le_bytes());
    set_core_i128(
        bytes,
        V3_CORE_MAXIMUM_POSITION_OFFSET,
        config.maximum_position,
    )?;
    set_core_i128(
        bytes,
        V3_CORE_MAXIMUM_OPEN_INTEREST_OFFSET,
        config.maximum_open_interest,
    )?;
    set_core_i128(bytes, V3_CORE_CURRENT_OPEN_INTEREST_OFFSET, 0)?;
    bytes[V3_CORE_MARK_DEVIATION_BPS_OFFSET..V3_CORE_MARK_DEVIATION_BPS_OFFSET + 2]
        .copy_from_slice(&config.mark_deviation_bps.to_le_bytes());
    set_core_i128(bytes, V3_CORE_PROTOCOL_FEE_BALANCE_OFFSET, 0)?;
    set_core_i128(bytes, V3_CORE_INSURANCE_BALANCE_OFFSET, 0)?;
    set_core_i128(bytes, V3_CORE_BAD_DEBT_OFFSET, 0)?;
    set_core_i128(bytes, V3_CORE_VAULT_LIABILITY_OFFSET, 0)?;
    bytes[V3_CORE_RECONCILIATION_STATUS_OFFSET] = 0;
    bytes[V3_CORE_RISK_CONFIG_VERSION_OFFSET] = V3_RISK_CONFIG_VERSION;
    Ok(())
}

/// Governance-authorized V3 risk update. The core is the only durable config
/// authority for a sharded market; this instruction never interprets V2
/// offsets and rejects malformed or unsafe values before any write.
pub fn update_v3_risk_config(
    program_id: &Address,
    accounts: &mut [AccountView],
    config: V3RiskConfig,
) -> ProgramResult {
    if accounts.len() < 2 || !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[0].owned_by(program_id) || !accounts[0].is_writable() {
        return Err(bundle_error());
    }
    let authority = accounts[1].address().to_bytes();
    let mut core = unsafe { accounts[0].borrow_unchecked_mut() };
    let current_open_interest = core_i128(&core, V3_CORE_CURRENT_OPEN_INTEREST_OFFSET)?;
    if core.len() != V3_MARKET_CORE_SIZE
        || core[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || core[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || core[10] != 1
        || core[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32] != authority
        || config.initial_margin_bps == 0
        || config.maintenance_margin_bps == 0
        || config.maintenance_margin_bps > config.initial_margin_bps
        || config.liquidation_fee_bps > 1_000
        || config.maker_fee_bps > 1_000
        || config.taker_fee_bps > 1_000
        || config.maximum_leverage == 0
        || config.maximum_leverage > 100
        || config.maximum_position < 0
        || config.maximum_open_interest < 0
        || current_open_interest < 0
        || (config.maximum_open_interest > 0
            && current_open_interest > config.maximum_open_interest)
        || config.mark_deviation_bps > 10_000
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    core[V3_CORE_INITIAL_MARGIN_BPS_OFFSET..V3_CORE_INITIAL_MARGIN_BPS_OFFSET + 2]
        .copy_from_slice(&config.initial_margin_bps.to_le_bytes());
    core[V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET..V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET + 2]
        .copy_from_slice(&config.maintenance_margin_bps.to_le_bytes());
    core[V3_CORE_LIQUIDATION_FEE_BPS_OFFSET..V3_CORE_LIQUIDATION_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.liquidation_fee_bps.to_le_bytes());
    core[V3_CORE_MAKER_FEE_BPS_OFFSET..V3_CORE_MAKER_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.maker_fee_bps.to_le_bytes());
    core[V3_CORE_TAKER_FEE_BPS_OFFSET..V3_CORE_TAKER_FEE_BPS_OFFSET + 2]
        .copy_from_slice(&config.taker_fee_bps.to_le_bytes());
    core[V3_CORE_MAXIMUM_LEVERAGE_OFFSET..V3_CORE_MAXIMUM_LEVERAGE_OFFSET + 4]
        .copy_from_slice(&config.maximum_leverage.to_le_bytes());
    set_core_i128(
        &mut core,
        V3_CORE_MAXIMUM_POSITION_OFFSET,
        config.maximum_position,
    )?;
    set_core_i128(
        &mut core,
        V3_CORE_MAXIMUM_OPEN_INTEREST_OFFSET,
        config.maximum_open_interest,
    )?;
    core[V3_CORE_MARK_DEVIATION_BPS_OFFSET..V3_CORE_MARK_DEVIATION_BPS_OFFSET + 2]
        .copy_from_slice(&config.mark_deviation_bps.to_le_bytes());
    core[V3_CORE_RISK_CONFIG_VERSION_OFFSET] = V3_RISK_CONFIG_VERSION;
    Ok(())
}

fn v3_trade_seat(
    accounts: &[AccountView],
    seat_index: u16,
) -> Result<(TraderSeat, usize, usize), ProgramError> {
    let index = seat_index as usize;
    if index >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let shard = index / V3_SEATS_PER_SHARD;
    let slot = index % V3_SEATS_PER_SHARD;
    let seat = read_shard_seat(
        unsafe { accounts[1 + (2 * V3_BOOK_PAGES_PER_SIDE) + shard].borrow_unchecked() },
        slot,
    )?;
    if seat.occupancy != 1 || seat.trader == [0; 32] {
        return Err(StockStreamError::InvalidSeat.into());
    }
    Ok((seat, shard, slot))
}

fn validate_v3_trade_accounts(
    program_id: &Address,
    accounts: &[AccountView],
    seat_index: u16,
    required_actions: u8,
    notional: i128,
    resulting_exposure: u128,
    resulting_open_orders: u32,
    action_nonce: u64,
    now: u64,
) -> Result<(TraderSeat, Option<V3SessionAuthorization>), ProgramError> {
    if accounts.len() < V3_SIGNER_ACCOUNT_INDEX + 1
        || accounts.len() > V3_SESSION_ACCOUNT_INDEX + 1
        || !accounts[V3_SIGNER_ACCOUNT_INDEX].is_signer()
    {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_execution_bundle(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN], true)?;
    let core = &accounts[0];
    let core_bytes = unsafe { core.borrow_unchecked() };
    if core_bytes[V3_CORE_MODE_OFFSET] != 1
        || core_bytes[V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::Delegated as u8
    {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    if accounts[..V3_EXECUTION_BUNDLE_LEN]
        .iter()
        .any(|account| account.address() == accounts[V3_SIGNER_ACCOUNT_INDEX].address())
    {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let (seat, _, _) = v3_trade_seat(accounts, seat_index)?;
    let signer = *accounts[V3_SIGNER_ACCOUNT_INDEX].address();
    if seat.trader == signer.to_bytes() {
        if action_nonce != 0 {
            return Err(StockStreamError::InvalidInstruction.into());
        }
        return Ok((seat, None));
    }
    if accounts.len() != V3_SESSION_ACCOUNT_INDEX + 1
        || !accounts[V3_SESSION_ACCOUNT_INDEX].is_writable()
    {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    let auth = validate_v3_session_actor(
        program_id,
        core,
        &accounts
            [1 + (2 * V3_BOOK_PAGES_PER_SIDE)..1 + (2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS],
        &accounts[V3_SESSION_ACCOUNT_INDEX],
        &accounts[V3_SIGNER_ACCOUNT_INDEX],
        seat_index,
        required_actions,
        notional,
        resulting_exposure,
        resulting_open_orders,
        action_nonce,
        now,
    )?;
    Ok((seat, Some(auth)))
}

fn v3_trade_seat_shards(
    seat_accounts: &[AccountView],
    seat_index: u16,
) -> Result<(TraderSeat, usize, usize), ProgramError> {
    let index = seat_index as usize;
    if index >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD || seat_accounts.len() != V3_SEAT_SHARDS {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let shard = index / V3_SEATS_PER_SHARD;
    let slot = index % V3_SEATS_PER_SHARD;
    let seat = read_shard_seat(unsafe { seat_accounts[shard].borrow_unchecked() }, slot)?;
    if seat.occupancy != 1 || seat.trader == [0; 32] {
        return Err(StockStreamError::InvalidSeat.into());
    }
    Ok((seat, shard, slot))
}

fn write_v3_seat_shards(
    seat_accounts: &mut [AccountView],
    shard: usize,
    slot: usize,
    seat: &TraderSeat,
) -> ProgramResult {
    let mut bytes = unsafe { seat_accounts[shard].borrow_unchecked_mut() };
    write_shard_seat(&mut bytes, slot, seat)
}

fn settle_v3_fill(
    core: &mut AccountView,
    seat_accounts: &mut [AccountView],
    taker_seat_index: u16,
    taker_side: Side,
    fill: V3Fill,
    risk_config: V3RiskConfig,
) -> ProgramResult {
    if fill.maker_owner as usize >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD {
        return Err(StockStreamError::InvalidSeat.into());
    }
    if fill.maker_owner == taker_seat_index as u32 {
        return Err(StockStreamError::SelfTradeAborted.into());
    }
    let maker_index = fill.maker_owner as u16;
    let (maker_before, maker_shard, maker_slot) = v3_trade_seat_shards(seat_accounts, maker_index)?;
    let (taker_before, taker_shard, taker_slot) =
        v3_trade_seat_shards(seat_accounts, taker_seat_index)?;
    let maker_side = if taker_side == Side::Bid {
        Side::Ask
    } else {
        Side::Bid
    };
    let notional = u128::from(fill.quantity)
        .checked_mul(u128::from(fill.price))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let funding_accumulator = core_i128(
        unsafe { core.borrow_unchecked() },
        V3_CORE_FUNDING_ACCUMULATOR_OFFSET,
    )?;
    let mut maker = maker_before;
    let mut taker = taker_before;
    crate::risk::settle_funding(&mut maker, funding_accumulator).map_err(v3_risk_error)?;
    crate::risk::settle_funding(&mut taker, funding_accumulator).map_err(v3_risk_error)?;
    let maker_signed = if maker_side == Side::Bid {
        i128::from(fill.quantity)
    } else {
        -i128::from(fill.quantity)
    };
    let taker_signed = if taker_side == Side::Bid {
        i128::from(fill.quantity)
    } else {
        -i128::from(fill.quantity)
    };
    let maker_fee = crate::risk::apply_fill(
        &mut maker,
        maker_signed,
        i128::from(fill.price),
        risk_config.maker_fee_bps,
    )
    .map_err(v3_risk_error)?;
    let taker_fee = crate::risk::apply_fill(
        &mut taker,
        taker_signed,
        i128::from(fill.price),
        risk_config.taker_fee_bps,
    )
    .map_err(v3_risk_error)?;
    let margin = crate::risk::initial_margin(
        i128::try_from(notional).map_err(|_| StockStreamError::ArithmeticOverflow)?,
        risk_config.initial_margin_bps,
    )
    .map_err(v3_risk_error)?;
    maker.reserved_margin = maker
        .reserved_margin
        .checked_sub(margin)
        .ok_or(StockStreamError::RiskViolation)?;
    if fill.maker_remaining == 0 {
        maker.open_order_count = maker
            .open_order_count
            .checked_sub(1)
            .ok_or(StockStreamError::RiskViolation)?;
    }
    if maker_side == Side::Bid {
        maker.open_bid_exposure = maker
            .open_bid_exposure
            .checked_sub(i128::from(fill.quantity))
            .ok_or(StockStreamError::RiskViolation)?;
    } else {
        maker.open_ask_exposure = maker
            .open_ask_exposure
            .checked_sub(i128::from(fill.quantity))
            .ok_or(StockStreamError::RiskViolation)?;
    }
    let mut core_bytes = unsafe { core.borrow_unchecked_mut() };
    let protocol_balance = core_i128(&core_bytes, V3_CORE_PROTOCOL_FEE_BALANCE_OFFSET)?
        .checked_add(maker_fee)
        .and_then(|value| value.checked_add(taker_fee))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    set_core_i128(
        &mut core_bytes,
        V3_CORE_PROTOCOL_FEE_BALANCE_OFFSET,
        protocol_balance,
    )?;
    write_v3_seat_shards(seat_accounts, maker_shard, maker_slot, &maker)?;
    write_v3_seat_shards(seat_accounts, taker_shard, taker_slot, &taker)
}

fn v3_order_reserve(
    leaf: &LeafNode,
    tree: TreeKind,
    oracle: Option<i64>,
    config: V3RiskConfig,
) -> Result<i128, ProgramError> {
    let price = match tree {
        TreeKind::Fixed => leaf.price_or_offset,
        TreeKind::OraclePegged => oracle
            .ok_or(StockStreamError::OracleUnavailable)?
            .checked_add(leaf.price_or_offset)
            .ok_or(StockStreamError::ArithmeticOverflow)?,
    };
    if price <= 0 {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let notional = i128::from(leaf.quantity)
        .checked_mul(i128::from(price))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    crate::risk::initial_margin(notional, config.initial_margin_bps).map_err(v3_risk_error)
}

/// Returns the last stored oracle price for reserve accounting. Cancellation
/// must remain available during a stale/temporarily invalid oracle window; the
/// validity flag gates new pegged orders, while the stored price lets existing
/// reservations be released deterministically.
fn v3_reserve_oracle(core: &[u8]) -> Result<Option<i64>, ProgramError> {
    let price = i64::from_le_bytes(
        core[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    Ok((price > 0).then_some(price))
}

fn recompute_v3_open_interest(seat_accounts: &[AccountView]) -> Result<i128, ProgramError> {
    if seat_accounts.len() != V3_SEAT_SHARDS {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let mut total = 0i128;
    for shard in seat_accounts {
        for slot in 0..V3_SEATS_PER_SHARD {
            let seat = read_shard_seat(unsafe { shard.borrow_unchecked() }, slot)?;
            if seat.occupancy != 0 {
                total = total
                    .checked_add(
                        seat.base_position
                            .checked_abs()
                            .ok_or(StockStreamError::ArithmeticOverflow)?,
                    )
                    .ok_or(StockStreamError::ArithmeticOverflow)?;
            }
        }
    }
    Ok(total)
}

/// Projects open interest from an immutable match plan before any page, seat,
/// event, or core bytes are mutated. This keeps the maximum-open-interest
/// rejection path side-effect free even when a transaction is exercised
/// directly in a harness rather than rolled back by the runtime.
fn projected_v3_open_interest(
    seat_accounts: &[AccountView],
    taker_seat_index: u16,
    taker_side: Side,
    plan: &V3MatchPlan,
) -> Result<i128, ProgramError> {
    if seat_accounts.len() != V3_SEAT_SHARDS
        || usize::from(taker_seat_index) >= V3_SEAT_SHARDS * V3_SEATS_PER_SHARD
    {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let taker_signed = if taker_side == Side::Bid { 1 } else { -1 };
    let maker_signed = -taker_signed;
    let taker = usize::from(taker_seat_index);
    let mut total = 0i128;
    for shard in 0..V3_SEAT_SHARDS {
        let bytes = unsafe { seat_accounts[shard].borrow_unchecked() };
        for slot in 0..V3_SEATS_PER_SHARD {
            let index = shard * V3_SEATS_PER_SHARD + slot;
            let seat = read_shard_seat(&bytes, slot)?;
            let mut position = seat.base_position;
            for fill in plan.fills[..plan.fill_count as usize].iter() {
                let quantity = i128::from(fill.quantity);
                if usize::try_from(fill.maker_owner).map_err(|_| StockStreamError::InvalidSeat)?
                    == index
                {
                    position = position
                        .checked_add(maker_signed * quantity)
                        .ok_or(StockStreamError::ArithmeticOverflow)?;
                }
                if taker == index {
                    position = position
                        .checked_add(taker_signed * quantity)
                        .ok_or(StockStreamError::ArithmeticOverflow)?;
                }
            }
            total = total
                .checked_add(
                    position
                        .checked_abs()
                        .ok_or(StockStreamError::ArithmeticOverflow)?,
                )
                .ok_or(StockStreamError::ArithmeticOverflow)?;
        }
    }
    Ok(total)
}

/// Executes a delegated V3 place order against the canonical 27-account
/// bundle.  This path intentionally keeps token vaults and L1 custody out of
/// the delegated cluster: collateral is reserved on the seat, while the
/// vault remains an L1 account reconciled before withdrawal.
pub fn place_order_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
) -> ProgramResult {
    place_order_v3_with_action(
        program_id,
        accounts,
        order,
        crate::session::SESSION_ACTION_PLACE,
        true,
    )
}

/// Liquidates a V3 seat against the verified oracle mark. The market
/// authority is the scoped keeper authority for this compact path; all
/// position/PnL/fee mutations use the same checked risk primitives as fills.
pub fn liquidate_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    max_quantity: u64,
) -> ProgramResult {
    if accounts.len() != V3_EXECUTION_BUNDLE_LEN + 1 || max_quantity == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    validate_execution_bundle(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN], true)?;
    let signer = &accounts[V3_SIGNER_ACCOUNT_INDEX];
    if !signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (mark, funding, config) = {
        let core = unsafe { accounts[0].borrow_unchecked() };
        if core[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != signer.address().to_bytes()
            || core[V3_CORE_ORACLE_VALID_OFFSET] != 1
        {
            return Err(StockStreamError::InvalidInstruction.into());
        }
        let mark = i64::from_le_bytes(
            core[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
                .try_into()
                .map_err(|_| bundle_error())?,
        );
        if mark <= 0 {
            return Err(StockStreamError::OracleUnavailable.into());
        }
        (
            mark as i128,
            core_i128(&core, V3_CORE_FUNDING_ACCUMULATOR_OFFSET)?,
            read_v3_risk_config(&core)?,
        )
    };
    let (seat_before, shard, slot) = v3_trade_seat(accounts, seat_index)?;
    // Funding is part of the liquidation health check. Settle it on a copy
    // before evaluating maintenance margin so a stale accumulator cannot let
    // an under-margined seat escape liquidation (or liquidate a healthy one).
    let mut settled_seat = seat_before;
    crate::risk::settle_funding(&mut settled_seat, funding).map_err(v3_risk_error)?;
    if !crate::risk::is_liquidatable(&settled_seat, mark, config.maintenance_margin_bps)
        .map_err(v3_risk_error)?
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    let quantity = crate::risk::partial_liquidation_quantity(
        &settled_seat,
        mark,
        config.maintenance_margin_bps,
    )
    .map_err(v3_risk_error)?
    .min(i128::from(max_quantity));
    if quantity <= 0 {
        return Err(StockStreamError::RiskViolation.into());
    }
    let signed = if seat_before.base_position > 0 {
        -quantity
    } else {
        quantity
    };
    let mut seat = settled_seat;
    let fee = crate::risk::apply_fill(&mut seat, signed, mark, config.liquidation_fee_bps)
        .map_err(v3_risk_error)?;
    crate::risk::set_liquidation_state(&mut seat, mark, config.maintenance_margin_bps)
        .map_err(v3_risk_error)?;
    let old_abs = seat_before
        .base_position
        .checked_abs()
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let new_abs = seat
        .base_position
        .checked_abs()
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let open_interest_reduction = old_abs
        .checked_sub(new_abs)
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let post_liquidation_equity = crate::risk::equity(&seat, mark).map_err(v3_risk_error)?;
    write_v3_seat_shards(
        &mut accounts
            [1 + (2 * V3_BOOK_PAGES_PER_SIDE)..1 + (2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS],
        shard,
        slot,
        &seat,
    )?;
    {
        let mut core = unsafe { accounts[0].borrow_unchecked_mut() };
        let insurance = core_i128(&core, V3_CORE_INSURANCE_BALANCE_OFFSET)?
            .checked_add(fee)
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        set_core_i128(&mut core, V3_CORE_INSURANCE_BALANCE_OFFSET, insurance)?;
        let current_open_interest = core_i128(&core, V3_CORE_CURRENT_OPEN_INTEREST_OFFSET)?;
        let updated_open_interest = current_open_interest
            .checked_sub(open_interest_reduction)
            .ok_or(StockStreamError::RiskViolation)?;
        if updated_open_interest < 0 {
            return Err(StockStreamError::RiskViolation.into());
        }
        set_core_i128(
            &mut core,
            V3_CORE_CURRENT_OPEN_INTEREST_OFFSET,
            updated_open_interest,
        )?;
        if post_liquidation_equity < 0 {
            let bad_debt = post_liquidation_equity
                .checked_neg()
                .ok_or(StockStreamError::ArithmeticOverflow)?;
            let recognized = core_i128(&core, V3_CORE_BAD_DEBT_OFFSET)?
                .checked_add(bad_debt)
                .ok_or(StockStreamError::ArithmeticOverflow)?;
            set_core_i128(&mut core, V3_CORE_BAD_DEBT_OFFSET, recognized)?;
        }
    }
    let (core_accounts, rest) = accounts.split_at_mut(1);
    let (book_accounts, rest) = rest.split_at_mut(2 * V3_BOOK_PAGES_PER_SIDE);
    let (_seat_accounts, event_accounts) = rest.split_at_mut(V3_SEAT_SHARDS);
    let _ = book_accounts;
    let quantity_u64 = quantity as u64;
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::LiquidationStarted as u16,
        &crate::events::payload_liquidation(seat_index, quantity_u64, mark as i64),
        crate::handlers::event_timestamp(),
    )?;
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::PositionChanged as u16,
        &crate::events::payload_position(seat_index, seat.base_position, seat.quote_entry_value),
        crate::handlers::event_timestamp(),
    )?;
    Ok(())
}

fn place_order_v3_with_action(
    program_id: &Address,
    accounts: &mut [AccountView],
    order: PlaceOrderData,
    required_actions: u8,
    consume_session: bool,
) -> ProgramResult {
    if accounts.len() < V3_SIGNER_ACCOUNT_INDEX + 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let now = core_u64(
        unsafe { accounts[0].borrow_unchecked() },
        V3_CORE_ORACLE_TIMESTAMP_OFFSET,
    )?;
    let (seat_snapshot, _, _) = v3_trade_seat(accounts, order.seat_index)?;
    let side = match order.side {
        0 => Side::Bid,
        1 => Side::Ask,
        _ => return Err(StockStreamError::InvalidInstruction.into()),
    };
    let tree = match order.tree {
        0 => TreeKind::Fixed,
        1 => TreeKind::OraclePegged,
        _ => return Err(StockStreamError::InvalidInstruction.into()),
    };
    if order.quantity == 0 || order.flags & !31 != 0 || order.expires_at <= now {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let core_snapshot = unsafe { accounts[0].borrow_unchecked() };
    let risk_config = read_v3_risk_config(&core_snapshot)?;
    let oracle = if core_snapshot[V3_CORE_ORACLE_VALID_OFFSET] != 0 {
        Some(i64::from_le_bytes(
            core_snapshot[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
                .try_into()
                .map_err(|_| bundle_error())?,
        ))
    } else {
        None
    };
    let effective_price = match tree {
        TreeKind::Fixed => order.price_or_offset,
        TreeKind::OraclePegged => oracle
            .ok_or(StockStreamError::OracleUnavailable)?
            .checked_add(order.price_or_offset)
            .ok_or(StockStreamError::ArithmeticOverflow)?,
    };
    if effective_price <= 0 {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let notional = i128::from(order.quantity)
        .checked_mul(i128::from(effective_price))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let signed = if side == Side::Bid {
        i128::from(order.quantity)
    } else {
        -i128::from(order.quantity)
    };
    let resulting_exposure = seat_snapshot
        .base_position
        .checked_add(signed)
        .ok_or(StockStreamError::ArithmeticOverflow)?
        .unsigned_abs();
    if order.flags & 4 != 0 {
        let current_exposure = seat_snapshot.base_position.unsigned_abs();
        // A reduce-only order must oppose a non-zero position and cannot
        // consume more than that position. Checking the requested quantity
        // itself is essential: an oversized order can otherwise reduce the
        // absolute exposure while still flipping the seat's direction.
        if seat_snapshot.base_position == 0
            || u128::from(order.quantity) > current_exposure
            || resulting_exposure >= current_exposure
        {
            return Err(StockStreamError::RiskViolation.into());
        }
    }
    if resulting_exposure
        .checked_mul(u128::from(effective_price as u64))
        .ok_or(StockStreamError::ArithmeticOverflow)?
        > u128::try_from(seat_snapshot.available_collateral.max(0))
            .map_err(|_| StockStreamError::RiskViolation)?
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    if risk_config.maximum_position > 0 && resulting_exposure > risk_config.maximum_position as u128
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    let initial_requirement = crate::risk::initial_margin(notional, risk_config.initial_margin_bps)
        .map_err(v3_risk_error)?;
    if seat_snapshot
        .available_collateral
        .checked_sub(seat_snapshot.reserved_margin)
        .ok_or(StockStreamError::RiskViolation)?
        < initial_requirement
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    let sequence = {
        let bytes = unsafe { accounts[0].borrow_unchecked() };
        core_u64(bytes, V3_CORE_GLOBAL_ORDER_SEQUENCE_OFFSET)?
            .checked_add(1)
            .ok_or(StockStreamError::ArithmeticOverflow)?
    };
    let self_trade_behavior = SelfTradeBehavior::from_u8((order.flags >> 3) & 0b11)
        .ok_or(StockStreamError::InvalidInstruction)?;
    let input = OrderInput {
        side,
        tree,
        owner: order.seat_index as u32,
        price_or_offset: order.price_or_offset,
        sequence,
        quantity: order.quantity,
        expires_at: order.expires_at,
        peg_limit: order.peg_limit,
        client_order_id: order.client_order_id,
        time_in_force: if order.flags & 2 != 0 {
            TimeInForce::ImmediateOrCancel
        } else {
            TimeInForce::GoodTilCancelled
        },
        post_only: order.flags & 1 != 0,
        self_trade_behavior,
    };
    let leaf = input.leaf().map_err(|_| bundle_error())?;
    if tree == TreeKind::OraclePegged
        && !matches!(
            crate::book::pegged_state(&leaf, oracle, now),
            crate::book::PeggedState::Valid(_)
        )
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    let plan = {
        let (book_accounts, _) = accounts[1..].split_at_mut(2 * V3_BOOK_PAGES_PER_SIDE);
        let (bid_pages, ask_pages) = book_accounts.split_at_mut(V3_BOOK_PAGES_PER_SIDE);
        let mut bid_book = PagedBookV3::new(bid_pages)?;
        let mut ask_book = PagedBookV3::new(ask_pages)?;
        let opposite = if side == Side::Bid {
            &mut ask_book
        } else {
            &mut bid_book
        };
        let plan = opposite.plan_crossing_cross_tree(
            side,
            order.seat_index as u32,
            self_trade_behavior,
            effective_price,
            order.quantity,
            oracle,
            now,
        )?;
        if order.flags & 1 != 0 && (plan.fill_count != 0 || plan.cancellation_count != 0) {
            return Err(StockStreamError::RiskViolation.into());
        }
        plan
    };
    let projected_open_interest = projected_v3_open_interest(
        &accounts
            [1 + (2 * V3_BOOK_PAGES_PER_SIDE)..1 + (2 * V3_BOOK_PAGES_PER_SIDE) + V3_SEAT_SHARDS],
        order.seat_index,
        side,
        &plan,
    )?;
    if risk_config.maximum_open_interest > 0
        && projected_open_interest > risk_config.maximum_open_interest
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    let resulting_open_orders = seat_snapshot
        .open_order_count
        .checked_add(if plan.taker_remaining > 0 && order.flags & 2 == 0 {
            1
        } else {
            0
        })
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let (_, session) = validate_v3_trade_accounts(
        program_id,
        accounts,
        order.seat_index,
        required_actions
            | if order.flags & 4 != 0 {
                crate::session::SESSION_ACTION_REDUCE_ONLY_CLOSE
            } else {
                0
            },
        notional,
        resulting_exposure,
        resulting_open_orders,
        order.action_nonce,
        now,
    )?;
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (book_accounts, tail) = tail.split_at_mut(2 * V3_BOOK_PAGES_PER_SIDE);
    let (seat_accounts, event_accounts) = tail.split_at_mut(V3_SEAT_SHARDS);
    let (bid_pages, ask_pages) = book_accounts.split_at_mut(V3_BOOK_PAGES_PER_SIDE);
    let mut bid_book = PagedBookV3::new(bid_pages)?;
    let mut ask_book = PagedBookV3::new(ask_pages)?;
    let opposite = if side == Side::Bid {
        &mut ask_book
    } else {
        &mut bid_book
    };
    opposite.apply_match_plan(tree, &plan)?;
    for cancel in plan.cancellations[..plan.cancellation_count as usize].iter() {
        let (seat, shard, slot) = v3_trade_seat_shards(seat_accounts, cancel.maker_owner as u16)?;
        let mut updated = seat;
        let reserve_notional = i128::from(cancel.quantity)
            .checked_mul(i128::from(cancel.price))
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        let reserve = crate::risk::initial_margin(reserve_notional, risk_config.initial_margin_bps)
            .map_err(v3_risk_error)?;
        updated.reserved_margin = updated
            .reserved_margin
            .checked_sub(reserve)
            .ok_or(StockStreamError::RiskViolation)?;
        updated.open_order_count = updated.open_order_count.saturating_sub(1);
        if cancel.side == Side::Bid as u8 {
            updated.open_bid_exposure = updated
                .open_bid_exposure
                .saturating_sub(i128::from(cancel.quantity));
        } else {
            updated.open_ask_exposure = updated
                .open_ask_exposure
                .saturating_sub(i128::from(cancel.quantity));
        }
        write_v3_seat_shards(seat_accounts, shard, slot, &updated)?;
    }
    for fill in plan.fills[..plan.fill_count as usize].iter() {
        settle_v3_fill(
            &mut core_accounts[0],
            seat_accounts,
            order.seat_index,
            side,
            *fill,
            risk_config,
        )?;
    }
    let remaining = plan.taker_remaining;
    drop(bid_book);
    drop(ask_book);
    if remaining > 0 && order.flags & 2 == 0 {
        let mut resting = leaf;
        resting.quantity = remaining;
        let reserve_notional = i128::from(remaining)
            .checked_mul(i128::from(effective_price))
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        let reserve = crate::risk::initial_margin(reserve_notional, risk_config.initial_margin_bps)
            .map_err(v3_risk_error)?;
        let (seat, shard, slot) = v3_trade_seat_shards(seat_accounts, order.seat_index)?;
        if seat
            .available_collateral
            .checked_sub(seat.reserved_margin)
            .ok_or(StockStreamError::RiskViolation)?
            < reserve
        {
            return Err(StockStreamError::RiskViolation.into());
        }
        let mut updated = seat;
        updated.reserved_margin = updated
            .reserved_margin
            .checked_add(reserve)
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        updated.open_order_count = updated
            .open_order_count
            .checked_add(1)
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        if side == Side::Bid {
            updated.open_bid_exposure = updated
                .open_bid_exposure
                .checked_add(i128::from(remaining))
                .ok_or(StockStreamError::ArithmeticOverflow)?;
        } else {
            updated.open_ask_exposure = updated
                .open_ask_exposure
                .checked_add(i128::from(remaining))
                .ok_or(StockStreamError::ArithmeticOverflow)?;
        }
        write_v3_seat_shards(seat_accounts, shard, slot, &updated)?;
        if side == Side::Bid {
            let (bid_pages, _) = book_accounts.split_at_mut(V3_BOOK_PAGES_PER_SIDE);
            PagedBookV3::new(bid_pages)?.insert_resting_order(tree, resting)?;
        } else {
            let (_, ask_pages) = book_accounts.split_at_mut(V3_BOOK_PAGES_PER_SIDE);
            PagedBookV3::new(ask_pages)?.insert_resting_order(tree, resting)?;
        }
    }
    {
        let core = unsafe { core_accounts[0].borrow_unchecked_mut() };
        let open_interest = recompute_v3_open_interest(seat_accounts)?;
        if risk_config.maximum_open_interest > 0
            && open_interest > risk_config.maximum_open_interest
        {
            return Err(StockStreamError::RiskViolation.into());
        }
        set_core_i128(core, V3_CORE_CURRENT_OPEN_INTEREST_OFFSET, open_interest)?;
        set_core_u64(core, V3_CORE_GLOBAL_ORDER_SEQUENCE_OFFSET, sequence)?;
    }
    let payload = crate::events::payload_order(
        order.seat_index,
        leaf.key,
        order.side,
        effective_price,
        order.quantity,
    );
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::OrderPlaced as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )?;
    for cancel in plan.cancellations[..plan.cancellation_count as usize].iter() {
        let payload = crate::events::payload_order(
            cancel.maker_owner as u16,
            cancel.key,
            cancel.side,
            i64::try_from(cancel.price).map_err(|_| StockStreamError::ArithmeticOverflow)?,
            cancel.quantity,
        );
        append_event_record(
            program_id,
            &mut core_accounts[0],
            &mut event_accounts[..V3_EVENT_SHARDS],
            crate::events::EventKind::OrderCancelled as u16,
            &payload,
            crate::handlers::event_timestamp(),
        )?;
    }
    for fill in plan.fills[..plan.fill_count as usize].iter() {
        let payload = crate::events::payload_fill(
            fill.maker_owner,
            order.seat_index as u32,
            i64::try_from(fill.price).map_err(|_| StockStreamError::ArithmeticOverflow)?,
            fill.quantity,
            sequence,
        );
        append_event_record(
            program_id,
            &mut core_accounts[0],
            &mut event_accounts[..V3_EVENT_SHARDS],
            if fill.maker_remaining == 0 {
                crate::events::EventKind::OrderFilled as u16
            } else {
                crate::events::EventKind::OrderPartiallyFilled as u16
            },
            &payload,
            crate::handlers::event_timestamp(),
        )?;
    }
    if consume_session {
        if let Some(auth) = session {
            crate::handlers::consume_session_action(
                &mut accounts[V3_SESSION_ACCOUNT_INDEX],
                auth.session,
                notional,
                order.action_nonce,
                now,
            )?;
        }
    }
    Ok(())
}

/// L1 V3 deposit. Accounts are `[core, seat_shard, event_shard[4],
/// authority, source_token, vault, mint, token_program]`. Token vaults never
/// enter the delegated execution bundle; only the seat ledger and durable
/// event queue are updated here.
pub fn deposit_collateral_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    amount: u64,
) -> ProgramResult {
    if accounts.len() != 11 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for index in 0..accounts.len() {
        if accounts[..index]
            .iter()
            .any(|other| other.address() == accounts[index].address())
        {
            return Err(StockStreamError::CustodyViolation.into());
        }
    }
    let core = &accounts[0];
    let authority = &accounts[6];
    if !authority.is_signer() || !accounts[0].is_writable() || !accounts[1].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !core.owned_by(program_id) || unsafe { core.borrow_unchecked() }.len() != V3_MARKET_CORE_SIZE
    {
        return Err(StockStreamError::InvalidMarketLayout.into());
    }
    let (shard, slot) = (
        (seat_index as usize) / V3_SEATS_PER_SHARD,
        (seat_index as usize) % V3_SEATS_PER_SHARD,
    );
    if shard >= V3_SEAT_SHARDS {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let core_key = *core.address();
    let core_bytes = unsafe { core.borrow_unchecked() };
    if core_bytes[0..8] != V3_MARKET_CORE_DISCRIMINATOR
        || core_bytes[8..10] != V3_LAYOUT_VERSION.to_le_bytes()
        || core_bytes[V3_CORE_MODE_OFFSET] != 1
        || matches!(
            core_bytes[V3_CORE_DELEGATION_STATUS_OFFSET],
            x if x == DelegationStatus::Delegated as u8
                || x == DelegationStatus::Undelegating as u8
        )
        || core_bytes[V3_CORE_COMMIT_PHASE_OFFSET] != V3_COMMIT_PHASE_IDLE
        || core_bytes[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != authority.address().to_bytes()
    {
        return Err(StockStreamError::CustodyViolation.into());
    }
    validate_seat_shard(program_id, &accounts[1], &core_key, shard as u8)?;
    if *accounts[8].address() != crate::handlers::derive_vault(&core_key, program_id)
        || *accounts[10].address() != pinocchio_token::ID
        || *accounts[9].address()
            != Address::new_from_array(core_bytes[76..108].try_into().map_err(|_| bundle_error())?)
    {
        return Err(StockStreamError::CustodyViolation.into());
    }
    let vault_authority = crate::handlers::derive_vault_authority(&core_key, program_id);
    {
        let source = TokenAccount::from_account_view(&accounts[7])
            .map_err(|_| StockStreamError::CustodyViolation)?;
        let vault = TokenAccount::from_account_view(&accounts[8])
            .map_err(|_| StockStreamError::CustodyViolation)?;
        if *source.owner() != *authority.address()
            || *source.mint() != *accounts[9].address()
            || source.amount() < amount
            || *vault.owner() != vault_authority
            || *vault.mint() != *accounts[9].address()
        {
            return Err(StockStreamError::CustodyViolation.into());
        }
    }
    let mut seat = read_shard_seat(unsafe { accounts[1].borrow_unchecked() }, slot)?;
    if seat.occupancy != 1 || seat.trader != authority.address().to_bytes() {
        return Err(StockStreamError::InvalidSeat.into());
    }
    seat.available_collateral = seat
        .available_collateral
        .checked_add(i128::from(amount))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    Transfer::<&AccountView>::new(&accounts[7], &accounts[8], authority, amount)
        .invoke_with_program(accounts[10].address())?;
    write_shard_seat(unsafe { accounts[1].borrow_unchecked_mut() }, slot, &seat)?;
    let mut core_copy = accounts[0].clone();
    let mut event_copies = [
        accounts[2].clone(),
        accounts[3].clone(),
        accounts[4].clone(),
        accounts[5].clone(),
    ];
    let mut payload = [0u8; crate::events::EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..10].copy_from_slice(&amount.to_le_bytes());
    payload[10..18].copy_from_slice(&(seat.available_collateral.max(0) as u64).to_le_bytes());
    append_event_record(
        program_id,
        &mut core_copy,
        &mut event_copies,
        crate::events::EventKind::CollateralDeposited as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// L1 V3 withdrawal. The first 27 accounts are the complete execution
/// bundle, followed by `[authority, destination, mint, vault, vault_authority,
/// token_program]`. Requiring the full bundle makes restoration/finality a
/// structural property of the transaction rather than a caller assertion.
pub fn withdraw_collateral_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    amount: u64,
) -> ProgramResult {
    if accounts.len() != V3_EXECUTION_BUNDLE_LEN + 6 || amount == 0 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for index in 0..accounts.len() {
        if accounts[..index]
            .iter()
            .any(|other| other.address() == accounts[index].address())
        {
            return Err(StockStreamError::CustodyViolation.into());
        }
    }
    validate_v3_withdrawal_readiness(program_id, &accounts[..V3_EXECUTION_BUNDLE_LEN])?;
    let authority = &accounts[V3_EXECUTION_BUNDLE_LEN];
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let core_key = *accounts[0].address();
    let core_bytes = unsafe { accounts[0].borrow_unchecked() };
    if core_bytes[V3_CORE_MARKET_AUTHORITY_OFFSET..V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
        != authority.address().to_bytes()
    {
        return Err(StockStreamError::CustodyViolation.into());
    }
    let shard = (seat_index as usize) / V3_SEATS_PER_SHARD;
    let slot = (seat_index as usize) % V3_SEATS_PER_SHARD;
    if shard >= V3_SEAT_SHARDS {
        return Err(StockStreamError::InvalidSeat.into());
    }
    let seat_account_index = 1 + (2 * V3_BOOK_PAGES_PER_SIDE) + shard;
    let seat_account = accounts[seat_account_index].clone();
    let seat = read_shard_seat(unsafe { seat_account.borrow_unchecked() }, slot)?;
    if seat.occupancy != 1
        || seat.trader != authority.address().to_bytes()
        || seat.open_order_count != 0
    {
        return Err(StockStreamError::RiskViolation.into());
    }
    if core_bytes[V3_CORE_ORACLE_VALID_OFFSET] == 0 {
        return Err(StockStreamError::RiskViolation.into());
    }
    let mark_price = i64::from_le_bytes(
        core_bytes[V3_CORE_ORACLE_PRICE_OFFSET..V3_CORE_ORACLE_PRICE_OFFSET + 8]
            .try_into()
            .map_err(|_| bundle_error())?,
    );
    let funding_accumulator = core_i128(core_bytes, V3_CORE_FUNDING_ACCUMULATOR_OFFSET)?;
    let risk_config = read_v3_risk_config(&core_bytes)?;
    let mut seat = crate::risk::prepare_withdrawal(
        &seat,
        amount,
        funding_accumulator,
        i128::from(mark_price),
        risk_config.maintenance_margin_bps,
        crate::risk::DEFAULT_WITHDRAWAL_BUFFER,
    )
    .map_err(v3_risk_error)?;
    let mint = &accounts[V3_EXECUTION_BUNDLE_LEN + 2];
    let vault = &accounts[V3_EXECUTION_BUNDLE_LEN + 3];
    let vault_authority = &accounts[V3_EXECUTION_BUNDLE_LEN + 4];
    let token_program = &accounts[V3_EXECUTION_BUNDLE_LEN + 5];
    if *vault.address() != crate::handlers::derive_vault(&core_key, program_id)
        || *vault_authority.address()
            != crate::handlers::derive_vault_authority(&core_key, program_id)
        || *token_program.address() != pinocchio_token::ID
        || *mint.address()
            != Address::new_from_array(core_bytes[76..108].try_into().map_err(|_| bundle_error())?)
    {
        return Err(StockStreamError::CustodyViolation.into());
    }
    {
        let destination = TokenAccount::from_account_view(&accounts[V3_EXECUTION_BUNDLE_LEN + 1])
            .map_err(|_| StockStreamError::CustodyViolation)?;
        let vault_state = TokenAccount::from_account_view(vault)
            .map_err(|_| StockStreamError::CustodyViolation)?;
        if *destination.owner() != *authority.address()
            || *destination.mint() != *mint.address()
            || *vault_state.mint() != *mint.address()
            || vault_state.amount() < amount
        {
            return Err(StockStreamError::CustodyViolation.into());
        }
    }
    seat.available_collateral = seat
        .available_collateral
        .checked_sub(i128::from(amount))
        .ok_or(StockStreamError::ArithmeticOverflow)?;
    let market_bytes = core_key.to_bytes();
    let (derived_vault_authority, bump_value) =
        Address::find_program_address(&[b"vault-authority", &market_bytes], program_id);
    if derived_vault_authority != *vault_authority.address() {
        return Err(StockStreamError::CustodyViolation.into());
    }
    let bump = [bump_value];
    let seeds = [
        Seed::from(b"vault-authority"),
        Seed::from(&market_bytes),
        Seed::from(&bump),
    ];
    let signer = [Signer::from(&seeds)];
    Transfer::<&AccountView>::new(
        vault,
        &accounts[V3_EXECUTION_BUNDLE_LEN + 1],
        vault_authority,
        amount,
    )
    .invoke_signed_with_program(&signer, token_program.address())?;
    write_shard_seat(
        unsafe { accounts[seat_account_index].borrow_unchecked_mut() },
        slot,
        &seat,
    )?;
    let mut core_copy = accounts[0].clone();
    let mut event_copies = [
        accounts[23].clone(),
        accounts[24].clone(),
        accounts[25].clone(),
        accounts[26].clone(),
    ];
    let mut payload = [0u8; crate::events::EVENT_PAYLOAD_SIZE];
    payload[0..2].copy_from_slice(&seat_index.to_le_bytes());
    payload[2..10].copy_from_slice(&amount.to_le_bytes());
    payload[10..18].copy_from_slice(&(seat.available_collateral.max(0) as u64).to_le_bytes());
    append_event_record(
        program_id,
        &mut core_copy,
        &mut event_copies,
        crate::events::EventKind::CollateralWithdrawn as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )
}

/// Cancels one V3 order by searching both canonical roots.  The owner is
/// always the seat encoded in the order leaf; a session signer can authorize
/// the action but cannot redirect cancellation to another seat.
pub fn cancel_order_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    order_key: u128,
    action_nonce: u64,
) -> ProgramResult {
    cancel_order_v3_with_action(
        program_id,
        accounts,
        seat_index,
        order_key,
        action_nonce,
        crate::session::SESSION_ACTION_CANCEL,
        true,
    )
}

fn cancel_order_v3_with_action(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    order_key: u128,
    action_nonce: u64,
    required_actions: u8,
    consume_session: bool,
) -> ProgramResult {
    let now = core_u64(
        unsafe { accounts[0].borrow_unchecked() },
        V3_CORE_ORACLE_TIMESTAMP_OFFSET,
    )?;
    let (seat_snapshot, _, _) = v3_trade_seat(accounts, seat_index)?;
    let (_, session) = validate_v3_trade_accounts(
        program_id,
        accounts,
        seat_index,
        required_actions,
        0,
        seat_snapshot.base_position.unsigned_abs(),
        seat_snapshot.open_order_count,
        action_nonce,
        now,
    )?;
    let (core_accounts, tail) = accounts.split_at_mut(1);
    let (book_accounts, tail) = tail.split_at_mut(2 * V3_BOOK_PAGES_PER_SIDE);
    let (seat_accounts, event_accounts) = tail.split_at_mut(V3_SEAT_SHARDS);
    let (bid_pages, ask_pages) = book_accounts.split_at_mut(V3_BOOK_PAGES_PER_SIDE);
    let mut removed: Option<(TreeKind, LeafNode)> = None;
    {
        let mut bid = PagedBookV3::new(bid_pages)?;
        if let Ok(handle) = bid.find(TreeKind::Fixed, order_key) {
            if bid.leaf(handle)?.owner == seat_index as u32 {
                removed = Some((
                    TreeKind::Fixed,
                    bid.cancel_owned_order(TreeKind::Fixed, order_key, seat_index as u32)?,
                ));
            }
        }
    }
    if removed.is_none() {
        let mut ask = PagedBookV3::new(ask_pages)?;
        if let Ok(handle) = ask.find(TreeKind::Fixed, order_key) {
            if ask.leaf(handle)?.owner == seat_index as u32 {
                removed = Some((
                    TreeKind::Fixed,
                    ask.cancel_owned_order(TreeKind::Fixed, order_key, seat_index as u32)?,
                ));
            }
        }
        if removed.is_none() {
            if let Ok(handle) = ask.find(TreeKind::OraclePegged, order_key) {
                if ask.leaf(handle)?.owner == seat_index as u32 {
                    removed = Some((
                        TreeKind::OraclePegged,
                        ask.cancel_owned_order(
                            TreeKind::OraclePegged,
                            order_key,
                            seat_index as u32,
                        )?,
                    ));
                }
            }
        }
    }
    if removed.is_none() {
        let mut bid = PagedBookV3::new(bid_pages)?;
        if let Ok(handle) = bid.find(TreeKind::OraclePegged, order_key) {
            if bid.leaf(handle)?.owner == seat_index as u32 {
                removed = Some((
                    TreeKind::OraclePegged,
                    bid.cancel_owned_order(TreeKind::OraclePegged, order_key, seat_index as u32)?,
                ));
            }
        }
    }
    let (tree, leaf) = removed.ok_or(StockStreamError::InvalidInstruction)?;
    let oracle = v3_reserve_oracle(unsafe { core_accounts[0].borrow_unchecked() })?;
    let reserve_price = match tree {
        TreeKind::Fixed => leaf.price_or_offset,
        TreeKind::OraclePegged => oracle
            .ok_or(StockStreamError::OracleUnavailable)?
            .checked_add(leaf.price_or_offset)
            .ok_or(StockStreamError::ArithmeticOverflow)?,
    };
    if reserve_price <= 0 {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let config = read_v3_risk_config(unsafe { core_accounts[0].borrow_unchecked() })?;
    let reserve = v3_order_reserve(&leaf, tree, oracle, config)?;
    let (seat, shard, slot) = v3_trade_seat_shards(seat_accounts, seat_index)?;
    let mut updated = seat;
    updated.reserved_margin = updated
        .reserved_margin
        .checked_sub(reserve)
        .ok_or(StockStreamError::RiskViolation)?;
    updated.open_order_count = updated
        .open_order_count
        .checked_sub(1)
        .ok_or(StockStreamError::RiskViolation)?;
    if leaf.side == Side::Bid as u8 {
        updated.open_bid_exposure = updated
            .open_bid_exposure
            .checked_sub(i128::from(leaf.quantity))
            .ok_or(StockStreamError::RiskViolation)?;
    } else {
        updated.open_ask_exposure = updated
            .open_ask_exposure
            .checked_sub(i128::from(leaf.quantity))
            .ok_or(StockStreamError::RiskViolation)?;
    }
    write_v3_seat_shards(seat_accounts, shard, slot, &updated)?;
    let payload = crate::events::payload_order(
        seat_index,
        leaf.key,
        leaf.side,
        leaf.price_or_offset,
        leaf.quantity,
    );
    append_event_record(
        program_id,
        &mut core_accounts[0],
        &mut event_accounts[..V3_EVENT_SHARDS],
        crate::events::EventKind::OrderCancelled as u16,
        &payload,
        crate::handlers::event_timestamp(),
    )?;
    if consume_session {
        if let Some(auth) = session {
            crate::handlers::consume_session_action(
                &mut accounts[V3_SESSION_ACCOUNT_INDEX],
                auth.session,
                0,
                action_nonce,
                now,
            )?;
        }
    }
    Ok(())
}

/// Cancels up to `max_cancellations` owner orders.  It scans the bounded
/// global handle space, so the operation is deterministic and cannot be
/// steered toward a caller-selected page.
pub fn cancel_all_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    seat_index: u16,
    max_cancellations: u8,
    action_nonce: u64,
) -> ProgramResult {
    if max_cancellations == 0 {
        return Err(StockStreamError::InvalidInstruction.into());
    }
    let now = core_u64(
        unsafe { accounts[0].borrow_unchecked() },
        V3_CORE_ORACLE_TIMESTAMP_OFFSET,
    )?;
    let (seat_snapshot, _, _) = v3_trade_seat(accounts, seat_index)?;
    let (_, session) = validate_v3_trade_accounts(
        program_id,
        accounts,
        seat_index,
        crate::session::SESSION_ACTION_CANCEL_ALL,
        0,
        seat_snapshot.base_position.unsigned_abs(),
        seat_snapshot.open_order_count,
        action_nonce,
        now,
    )?;
    let mut cancelled = 0u8;
    while cancelled < max_cancellations {
        let mut found = None;
        for side in 0..2usize {
            let mut pages: [AccountView; V3_BOOK_PAGES_PER_SIDE] = core::array::from_fn(|page| {
                accounts[1 + side * V3_BOOK_PAGES_PER_SIDE + page].clone()
            });
            let mut book = PagedBookV3::new(&mut pages)?;
            for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
                for handle in 0..V3_BOOK_SLOTS_PER_SIDE as u32 {
                    if book.node_tag(handle).ok() != Some(TAG_LEAF) {
                        continue;
                    }
                    let leaf = book.leaf(handle)?;
                    if leaf.owner == seat_index as u32
                        && book.find(tree, leaf.key).ok() == Some(handle)
                    {
                        found = Some((side, tree, leaf.key));
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let Some((side, tree, key)) = found else {
            break;
        };
        let (core_accounts, tail) = accounts.split_at_mut(1);
        let (book_accounts, tail) = tail.split_at_mut(2 * V3_BOOK_PAGES_PER_SIDE);
        let (seat_accounts, event_accounts) = tail.split_at_mut(V3_SEAT_SHARDS);
        let pages = if side == 0 {
            &mut book_accounts[..V3_BOOK_PAGES_PER_SIDE]
        } else {
            &mut book_accounts[V3_BOOK_PAGES_PER_SIDE..]
        };
        let leaf = PagedBookV3::new(pages)?.cancel_owned_order(tree, key, seat_index as u32)?;
        let (seat, shard, slot) = v3_trade_seat_shards(seat_accounts, seat_index)?;
        let mut updated = seat;
        let core_bytes = unsafe { core_accounts[0].borrow_unchecked() };
        let oracle = v3_reserve_oracle(&core_bytes)?;
        let config = read_v3_risk_config(&core_bytes)?;
        updated.reserved_margin = updated
            .reserved_margin
            .checked_sub(v3_order_reserve(&leaf, tree, oracle, config)?)
            .ok_or(StockStreamError::RiskViolation)?;
        updated.open_order_count = updated.open_order_count.saturating_sub(1);
        if leaf.side == Side::Bid as u8 {
            updated.open_bid_exposure = updated
                .open_bid_exposure
                .checked_sub(i128::from(leaf.quantity))
                .ok_or(StockStreamError::RiskViolation)?;
        } else {
            updated.open_ask_exposure = updated
                .open_ask_exposure
                .checked_sub(i128::from(leaf.quantity))
                .ok_or(StockStreamError::RiskViolation)?;
        }
        write_v3_seat_shards(seat_accounts, shard, slot, &updated)?;
        let payload = crate::events::payload_order(
            seat_index,
            leaf.key,
            leaf.side,
            leaf.price_or_offset,
            leaf.quantity,
        );
        append_event_record(
            program_id,
            &mut core_accounts[0],
            &mut event_accounts[..V3_EVENT_SHARDS],
            crate::events::EventKind::OrderCancelled as u16,
            &payload,
            crate::handlers::event_timestamp(),
        )?;
        cancelled = cancelled.saturating_add(1);
    }
    if let Some(auth) = session {
        crate::handlers::consume_session_action(
            &mut accounts[V3_SESSION_ACCOUNT_INDEX],
            auth.session,
            0,
            action_nonce,
            now,
        )?;
    }
    Ok(())
}

/// Replaces an order atomically. A session-authorized replacement validates
/// the dedicated replace permission, cancels without consuming the nonce, and
/// then inserts the replacement while consuming exactly one nonce.
pub fn replace_order_v3(
    program_id: &Address,
    accounts: &mut [AccountView],
    old_order_key: u128,
    new_order: PlaceOrderData,
) -> ProgramResult {
    if accounts.len() > V3_SESSION_ACCOUNT_INDEX + 1 {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    if new_order.action_nonce == 0 {
        cancel_order_v3(program_id, accounts, new_order.seat_index, old_order_key, 0)?;
        return place_order_v3(program_id, accounts, new_order);
    }
    if accounts.len() != V3_SESSION_ACCOUNT_INDEX + 1 {
        return Err(StockStreamError::InvalidTradingSession.into());
    }
    cancel_order_v3_with_action(
        program_id,
        accounts,
        new_order.seat_index,
        old_order_key,
        new_order.action_nonce,
        crate::session::SESSION_ACTION_REPLACE,
        false,
    )?;
    place_order_v3_with_action(
        program_id,
        accounts,
        new_order,
        crate::session::SESSION_ACTION_REPLACE,
        true,
    )
}

#[cfg(test)]
#[path = "v3_tests.rs"]
mod tests;
