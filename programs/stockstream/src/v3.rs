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

use core::{
    mem::{size_of, MaybeUninit},
    ptr,
};

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    book::{InnerNode, LeafNode, TreeKind, ANY_NODE_SIZE, NONE, TAG_INNER, TAG_LEAF},
    error::StockStreamError,
    state::{DelegationStatus, LiquidationState, TraderSeat, TRADER_SEAT_SIZE},
};

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
pub const V3_EVENT_RECORD_SIZE: usize = crate::events::EVENT_SIZE;
/// One fully hot V3 execution domain: core, 8 pages, 4 seat shards, and 4
/// event shards. Vaults remain outside this bundle on L1 by design.
pub const V3_EXECUTION_BUNDLE_LEN: usize = 1 + 8 + V3_SEAT_SHARDS + V3_EVENT_SHARDS;
const V3_CORE_GLOBAL_EVENT_SEQUENCE_OFFSET: usize = 148;
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
    pub events: [[u8; V3_EVENT_RECORD_SIZE]; V3_EVENTS_PER_SHARD],
}
pub const V3_EVENT_SHARD_SIZE: usize = size_of::<EventShardV3>();

const _: [(); 4_096] = [(); V3_MARKET_CORE_SIZE];
const _: [(); 22_592] = [(); V3_BOOK_PAGE_SIZE];
const _: [(); 8_236] = [(); V3_SEAT_SHARD_SIZE];
const _: [(); 3_244] = [(); V3_EVENT_SHARD_SIZE];

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
/// 88-byte representation and use side-global handles (`page * 256 + slot`),
/// so an inner node may point into any page without a caller-selectable
/// translation layer. Page zero owns both roots and the global free/bump
/// metadata; pages 1..3 contain node slots only.
///
/// The adapter is deliberately account-backed, not a copied `Arena`: every
/// mutation is immediately applied to the supplied validated PDA pages.
pub struct PagedBookV3<'a> {
    pages: &'a mut [AccountView],
}

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
        data.get(offset..offset + 4)
            .ok_or_else(bundle_error)
            .map(|raw| u32::from_le_bytes(raw.try_into().unwrap()))
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
    let core_key = validate_active_core(program_id, core)?;
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

fn bundle_error() -> ProgramError {
    StockStreamError::InvalidInstruction.into()
}

/// Validates the exact account order required by future V3 trading handlers:
/// `[core, book(side 0/page 0..3), book(side 1/page 0..3), seat(0..3),
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
        || core_bytes[V3_CORE_MODE_OFFSET] != 1
    {
        return Err(bundle_error());
    }
    // A V2 market (wrong size/discriminator) cannot reach this point. A V3
    // delegated core is deliberately rejected here too: these program-owned
    // account views are only valid on the appropriate execution domain.
    if core_bytes[V3_CORE_DELEGATION_STATUS_OFFSET] > DelegationStatus::Restored as u8 {
        return Err(bundle_error());
    }
    let core_key = *core.address();
    for flat in 0..8usize {
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
        let account = &accounts[9 + shard];
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
        let account = &accounts[9 + V3_SEAT_SHARDS + shard];
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

fn read_shard_seat(bytes: &[u8], slot: usize) -> Result<TraderSeat, ProgramError> {
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

fn write_shard_seat(bytes: &mut [u8], slot: usize, seat: &TraderSeat) -> ProgramResult {
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
