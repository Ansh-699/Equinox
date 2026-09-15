//! Fixed-capacity, account-compatible PATRICIA order-book arenas.
//!
//! Keys are big-endian price-time values: the high 64 bits are the normalized
//! price and the low 64 bits are the placement sequence. Ask prices use their
//! unsigned price directly; bid prices use `u64::MAX - price`. Therefore an
//! unsigned ascending trie walk encounters the best price, then earliest
//! sequence, first on both sides.

use core::mem::size_of;

pub const ARENA_CAPACITY: usize = 1024;
pub const NONE: u32 = u32::MAX;
pub const NO_EXPIRY: u64 = u64::MAX;
pub const MAX_MATCH_FILLS: usize = 4;
pub const MAX_FILLS_PER_INSTRUCTION: usize = MAX_MATCH_FILLS;
pub const MAX_INVALID_REMOVALS: usize = 8;
pub const MAX_EXPIRED_REMOVALS: usize = 8;
pub const MAX_CANCELS_PER_INSTRUCTION: usize = 16;

const TAG_UNINITIALIZED: u8 = 0;
const TAG_INNER: u8 = 1;
const TAG_LEAF: u8 = 2;
const TAG_FREE: u8 = 3;
const TAG_LAST_FREE: u8 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Side {
    Bid = 0,
    Ask = 1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum TreeKind {
    Fixed = 0,
    OraclePegged = 1,
}

impl TreeKind {
    const fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum TimeInForce {
    GoodTilCancelled = 0,
    ImmediateOrCancel = 1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BookError {
    Full,
    DuplicateKey,
    MissingKey,
    BadHandle,
    BadTag,
    BadPrice,
    BadSequence,
    InvalidOwner,
    InvalidTree,
    Integrity,
    BadLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeggedState {
    Valid(i64),
    Invalid,
    Skipped,
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct InnerNode {
    pub tag: u8,
    pub _padding: [u8; 3],
    pub prefix_len: u32,
    pub key: u128,
    pub children: [u32; 2],
    pub child_earliest_expiry: [u64; 2],
    pub _reserved: [u8; 40],
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LeafNode {
    pub tag: u8,
    pub side: u8,
    pub time_in_force: u8,
    pub _padding: u8,
    pub owner: u32,
    pub key: u128,
    pub quantity: u64,
    pub expires_at: u64,
    pub peg_limit: i64,
    pub client_order_id: u64,
    pub price_or_offset: i64,
    pub sequence: u64,
    pub flags: u8,
    pub _reserved: [u8; 15],
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct FreeNode {
    pub tag: u8,
    pub _padding: [u8; 3],
    pub next: u32,
    pub _reserved: [u8; 80],
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LastFreeNode {
    pub tag: u8,
    pub _reserved: [u8; 87],
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub union AnyNode {
    pub inner: InnerNode,
    pub leaf: LeafNode,
    pub free: FreeNode,
    pub last_free: LastFreeNode,
}

const _: [(); 88] = [(); size_of::<InnerNode>()];
const _: [(); 88] = [(); size_of::<LeafNode>()];
const _: [(); 88] = [(); size_of::<FreeNode>()];
const _: [(); 88] = [(); size_of::<LastFreeNode>()];
const _: [(); 88] = [(); size_of::<AnyNode>()];

impl AnyNode {
    const fn uninitialized() -> Self {
        Self {
            last_free: LastFreeNode {
                tag: TAG_UNINITIALIZED,
                _reserved: [0; 87],
            },
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Arena {
    pub version: u8,
    pub _padding: [u8; 3],
    pub roots: [u32; 2],
    pub leaf_counts: [u32; 2],
    pub bump_index: u32,
    pub free_head: u32,
    pub free_len: u32,
    pub _reserved: [u8; 496],
    pub nodes: [AnyNode; ARENA_CAPACITY],
}

impl Arena {
    pub const fn new() -> Self {
        Self {
            version: 1,
            _padding: [0; 3],
            roots: [NONE; 2],
            leaf_counts: [0; 2],
            bump_index: 0,
            free_head: NONE,
            free_len: 0,
            _reserved: [0; 496],
            nodes: [AnyNode::uninitialized(); ARENA_CAPACITY],
        }
    }

    fn tag(&self, handle: u32) -> Result<u8, BookError> {
        if handle as usize >= ARENA_CAPACITY {
            return Err(BookError::BadHandle);
        }
        // All node variants place `tag` at byte zero. Reading that common byte
        // is valid after the explicit handle bounds check; callers validate the
        // discriminant before reading a variant payload.
        Ok(unsafe { self.nodes[handle as usize].inner.tag })
    }

    fn inner(&self, handle: u32) -> Result<InnerNode, BookError> {
        if self.tag(handle)? != TAG_INNER {
            return Err(BookError::BadTag);
        }
        // Discriminant validation above proves this union field was written.
        Ok(unsafe { self.nodes[handle as usize].inner })
    }

    pub fn leaf(&self, handle: u32) -> Result<LeafNode, BookError> {
        if self.tag(handle)? != TAG_LEAF {
            return Err(BookError::BadTag);
        }
        // Discriminant validation above proves this union field was written.
        Ok(unsafe { self.nodes[handle as usize].leaf })
    }

    fn write_inner(&mut self, handle: u32, node: InnerNode) {
        self.nodes[handle as usize] = AnyNode { inner: node };
    }

    fn write_leaf(&mut self, handle: u32, node: LeafNode) {
        self.nodes[handle as usize] = AnyNode { leaf: node };
    }

    pub fn apply_leaf_quantity(&mut self, handle: u32, quantity: u64) -> Result<(), BookError> {
        let mut leaf = self.leaf(handle)?;
        leaf.quantity = quantity;
        self.write_leaf(handle, leaf);
        Ok(())
    }

    /// Apply a quantity update after `validate_settlement_plan` has checked
    /// the handle, tag, key, owner, and expected quantity.
    pub unsafe fn apply_leaf_quantity_validated(&mut self, handle: u32, quantity: u64) {
        let mut leaf = unsafe { self.nodes[handle as usize].leaf };
        leaf.quantity = quantity;
        self.write_leaf(handle, leaf);
    }

    /// Remove a leaf after the complete identity and branch preconditions have
    /// been checked without mutating the account.
    pub unsafe fn remove_validated(&mut self, tree: TreeKind, key: u128) -> LeafNode {
        match self.remove(tree, key) {
            Ok(leaf) => leaf,
            Err(_) => unsafe { core::hint::unreachable_unchecked() },
        }
    }

    fn allocate(&mut self) -> Result<u32, BookError> {
        if self.free_head != NONE {
            let handle = self.free_head;
            let tag = self.tag(handle)?;
            self.free_head = match tag {
                TAG_FREE => unsafe { self.nodes[handle as usize].free.next },
                TAG_LAST_FREE => NONE,
                _ => return Err(BookError::BadTag),
            };
            self.free_len = self.free_len.checked_sub(1).ok_or(BookError::Integrity)?;
            return Ok(handle);
        }
        if self.bump_index as usize >= ARENA_CAPACITY {
            return Err(BookError::Full);
        }
        let handle = self.bump_index;
        self.bump_index += 1;
        Ok(handle)
    }

    fn recycle(&mut self, handle: u32) -> Result<(), BookError> {
        if handle >= self.bump_index || self.tag(handle)? == TAG_UNINITIALIZED {
            return Err(BookError::BadHandle);
        }
        self.nodes[handle as usize] = if self.free_head == NONE {
            AnyNode {
                last_free: LastFreeNode {
                    tag: TAG_LAST_FREE,
                    _reserved: [0; 87],
                },
            }
        } else {
            AnyNode {
                free: FreeNode {
                    tag: TAG_FREE,
                    _padding: [0; 3],
                    next: self.free_head,
                    _reserved: [0; 80],
                },
            }
        };
        self.free_head = handle;
        self.free_len = self.free_len.checked_add(1).ok_or(BookError::Integrity)?;
        Ok(())
    }

    /// Releases a first-stage split allocation before any node representation
    /// was written. This prevents a failed two-slot split from orphaning a bump
    /// slot at capacity.
    fn release_unwritten(&mut self, handle: u32) -> Result<(), BookError> {
        if handle >= self.bump_index {
            return Err(BookError::BadHandle);
        }
        if handle + 1 == self.bump_index {
            self.bump_index -= 1;
            return Ok(());
        }
        self.nodes[handle as usize] = if self.free_head == NONE {
            AnyNode {
                last_free: LastFreeNode {
                    tag: TAG_LAST_FREE,
                    _reserved: [0; 87],
                },
            }
        } else {
            AnyNode {
                free: FreeNode {
                    tag: TAG_FREE,
                    _padding: [0; 3],
                    next: self.free_head,
                    _reserved: [0; 80],
                },
            }
        };
        self.free_head = handle;
        self.free_len = self.free_len.checked_add(1).ok_or(BookError::Integrity)?;
        Ok(())
    }

    pub fn insert(&mut self, tree: TreeKind, leaf: LeafNode) -> Result<u32, BookError> {
        let key = leaf.key;
        let root_index = tree.index();
        let mut path = [(NONE, 0u8); 128];
        let mut depth = 0usize;
        let mut current = self.roots[root_index];

        if current == NONE {
            let handle = self.allocate()?;
            self.write_leaf(handle, leaf);
            self.roots[root_index] = handle;
            self.leaf_counts[root_index] += 1;
            return Ok(handle);
        }

        loop {
            match self.tag(current)? {
                TAG_LEAF => {
                    let existing = self.leaf(current)?;
                    if existing.key == key {
                        return Err(BookError::DuplicateKey);
                    }
                    let prefix = common_prefix(existing.key, key);
                    let new_handle = self.allocate()?;
                    let inner_handle = match self.allocate() {
                        Ok(handle) => handle,
                        Err(error) => {
                            self.release_unwritten(new_handle)?;
                            return Err(error);
                        }
                    };
                    self.write_leaf(new_handle, leaf);
                    let branch = key_bit(key, prefix) as usize;
                    self.write_inner(
                        inner_handle,
                        make_inner(prefix, existing.key, current, new_handle, branch),
                    );
                    self.refresh_inner(inner_handle)?;
                    self.replace_child(root_index, &path[..depth], inner_handle)?;
                    self.leaf_counts[root_index] += 1;
                    self.refresh_path(&path[..depth])?;
                    return Ok(new_handle);
                }
                TAG_INNER => {
                    let inner = self.inner(current)?;
                    let common = common_prefix(inner.key, key);
                    if common < inner.prefix_len {
                        let new_handle = self.allocate()?;
                        let inner_handle = match self.allocate() {
                            Ok(handle) => handle,
                            Err(error) => {
                                self.release_unwritten(new_handle)?;
                                return Err(error);
                            }
                        };
                        self.write_leaf(new_handle, leaf);
                        let branch = key_bit(key, common) as usize;
                        self.write_inner(
                            inner_handle,
                            make_inner(common, inner.key, current, new_handle, branch),
                        );
                        self.refresh_inner(inner_handle)?;
                        self.replace_child(root_index, &path[..depth], inner_handle)?;
                        self.leaf_counts[root_index] += 1;
                        self.refresh_path(&path[..depth])?;
                        return Ok(new_handle);
                    }
                    if depth == path.len() {
                        return Err(BookError::Integrity);
                    }
                    let branch = key_bit(key, inner.prefix_len) as usize;
                    path[depth] = (current, branch as u8);
                    depth += 1;
                    current = inner.children[branch];
                }
                _ => return Err(BookError::BadTag),
            }
        }
    }

    /// Checks the only allocation failure that `insert` can encounter after
    /// the key has been checked: the empty-root case needs one slot and every
    /// non-empty insertion needs a leaf plus an inner node.
    pub fn can_insert(
        &self,
        tree: TreeKind,
        key: u128,
        recycled_after_plan: u32,
    ) -> Result<(), BookError> {
        if self.find(tree, key).is_ok() {
            return Err(BookError::DuplicateKey);
        }
        let required = if self.roots[tree.index()] == NONE {
            1
        } else {
            2
        };
        let available = (ARENA_CAPACITY as u32)
            .saturating_sub(self.bump_index)
            .saturating_add(self.free_len)
            .saturating_add(recycled_after_plan);
        if available < required {
            return Err(BookError::Full);
        }
        Ok(())
    }

    pub fn find(&self, tree: TreeKind, key: u128) -> Result<u32, BookError> {
        let mut current = self.roots[tree.index()];
        while current != NONE {
            match self.tag(current)? {
                TAG_LEAF => {
                    return (self.leaf(current)?.key == key)
                        .then_some(current)
                        .ok_or(BookError::MissingKey)
                }
                TAG_INNER => {
                    let inner = self.inner(current)?;
                    if common_prefix(inner.key, key) < inner.prefix_len {
                        return Err(BookError::MissingKey);
                    }
                    current = inner.children[key_bit(key, inner.prefix_len) as usize];
                }
                _ => return Err(BookError::BadTag),
            }
        }
        Err(BookError::MissingKey)
    }

    pub fn remove(&mut self, tree: TreeKind, key: u128) -> Result<LeafNode, BookError> {
        let root_index = tree.index();
        let mut path = [(NONE, 0u8); 128];
        let mut depth = 0usize;
        let mut current = self.roots[root_index];
        if current == NONE {
            return Err(BookError::MissingKey);
        }
        while self.tag(current)? == TAG_INNER {
            let inner = self.inner(current)?;
            if common_prefix(inner.key, key) < inner.prefix_len || depth == path.len() {
                return Err(BookError::MissingKey);
            }
            let branch = key_bit(key, inner.prefix_len) as usize;
            path[depth] = (current, branch as u8);
            depth += 1;
            current = inner.children[branch];
        }
        let leaf = self.leaf(current)?;
        if leaf.key != key {
            return Err(BookError::MissingKey);
        }
        if depth == 0 {
            self.roots[root_index] = NONE;
        } else {
            let (parent_handle, branch) = path[depth - 1];
            let parent = self.inner(parent_handle)?;
            let sibling = parent.children[1 - branch as usize];
            self.replace_child(root_index, &path[..depth - 1], sibling)?;
            self.recycle(parent_handle)?;
        }
        self.recycle(current)?;
        self.leaf_counts[root_index] = self.leaf_counts[root_index]
            .checked_sub(1)
            .ok_or(BookError::Integrity)?;
        self.refresh_path(&path[..depth.saturating_sub(1)])?;
        Ok(leaf)
    }

    pub fn remove_owned(
        &mut self,
        tree: TreeKind,
        key: u128,
        owner: u32,
    ) -> Result<LeafNode, BookError> {
        let handle = self.find(tree, key)?;
        if self.leaf(handle)?.owner != owner {
            return Err(BookError::InvalidOwner);
        }
        self.remove(tree, key)
    }

    fn replace_child(
        &mut self,
        root_index: usize,
        path: &[(u32, u8)],
        replacement: u32,
    ) -> Result<(), BookError> {
        if let Some((parent_handle, branch)) = path.last() {
            let mut parent = self.inner(*parent_handle)?;
            parent.children[*branch as usize] = replacement;
            parent.child_earliest_expiry[*branch as usize] = self.subtree_expiry(replacement)?;
            self.write_inner(*parent_handle, parent);
        } else {
            self.roots[root_index] = replacement;
        }
        Ok(())
    }

    fn refresh_path(&mut self, path: &[(u32, u8)]) -> Result<(), BookError> {
        let mut index = path.len();
        while index > 0 {
            index -= 1;
            let handle = path[index].0;
            self.refresh_inner(handle)?;
        }
        Ok(())
    }

    fn refresh_inner(&mut self, handle: u32) -> Result<(), BookError> {
        let mut inner = self.inner(handle)?;
        inner.child_earliest_expiry = [
            self.subtree_expiry(inner.children[0])?,
            self.subtree_expiry(inner.children[1])?,
        ];
        self.write_inner(handle, inner);
        Ok(())
    }

    fn subtree_expiry(&self, handle: u32) -> Result<u64, BookError> {
        match self.tag(handle)? {
            TAG_LEAF => Ok(expiry_of(&self.leaf(handle)?)),
            TAG_INNER => {
                let node = self.inner(handle)?;
                Ok(node.child_earliest_expiry[0].min(node.child_earliest_expiry[1]))
            }
            _ => Err(BookError::BadTag),
        }
    }

    pub fn best(&self, tree: TreeKind) -> Result<Option<u32>, BookError> {
        let mut handle = self.roots[tree.index()];
        while handle != NONE {
            match self.tag(handle)? {
                TAG_LEAF => return Ok(Some(handle)),
                TAG_INNER => handle = self.inner(handle)?.children[0],
                _ => return Err(BookError::BadTag),
            }
        }
        Ok(None)
    }

    pub fn first_expired(&self, tree: TreeKind, now: u64) -> Result<Option<u32>, BookError> {
        let mut handle = self.roots[tree.index()];
        while handle != NONE {
            match self.tag(handle)? {
                TAG_LEAF => return Ok((expiry_of(&self.leaf(handle)?) <= now).then_some(handle)),
                TAG_INNER => {
                    let node = self.inner(handle)?;
                    handle = if node.child_earliest_expiry[0] <= now {
                        node.children[0]
                    } else if node.child_earliest_expiry[1] <= now {
                        node.children[1]
                    } else {
                        NONE
                    };
                }
                _ => return Err(BookError::BadTag),
            }
        }
        Ok(None)
    }

    pub fn sweep_expired(&mut self, tree: TreeKind, now: u64, max: u8) -> Result<u8, BookError> {
        let mut removed = 0u8;
        while removed < max {
            let Some(handle) = self.first_expired(tree, now)? else {
                break;
            };
            let key = self.leaf(handle)?.key;
            self.remove(tree, key)?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn cancel_owner(&mut self, owner: u32, max: u8) -> Result<u8, BookError> {
        Ok(self.cancel_owner_summary(owner, max)?.count)
    }

    pub fn cancel_owner_summary(
        &mut self,
        owner: u32,
        max: u8,
    ) -> Result<CancelSummary, BookError> {
        let mut removed = 0u8;
        let mut summary = CancelSummary::default();
        let mut tree_index = 0usize;
        while tree_index < 2 && removed < max {
            let tree = if tree_index == 0 {
                TreeKind::Fixed
            } else {
                TreeKind::OraclePegged
            };
            let mut handle = 0u32;
            while handle < self.bump_index && removed < max {
                let tag = self.tag(handle)?;
                if tag == TAG_LEAF {
                    let leaf = self.leaf(handle)?;
                    if leaf.owner == owner && self.find(tree, leaf.key) == Ok(handle) {
                        self.remove(tree, leaf.key)?;
                        removed += 1;
                        summary.count = removed;
                        if leaf.side == Side::Bid as u8 {
                            summary.bid_quantity = summary
                                .bid_quantity
                                .checked_add(leaf.quantity)
                                .ok_or(BookError::Integrity)?;
                        } else {
                            summary.ask_quantity = summary
                                .ask_quantity
                                .checked_add(leaf.quantity)
                                .ok_or(BookError::Integrity)?;
                        }
                        summary.reserved_notional = summary
                            .reserved_notional
                            .checked_add(
                                (leaf.quantity as u128)
                                    .checked_mul(leaf.price_or_offset.max(0) as u128)
                                    .ok_or(BookError::Integrity)?,
                            )
                            .ok_or(BookError::Integrity)?;
                    }
                }
                handle += 1;
            }
            tree_index += 1;
        }
        summary.count = removed;
        Ok(summary)
    }

    pub fn validate(&self) -> Result<(), BookError> {
        if self.bump_index as usize > ARENA_CAPACITY {
            return Err(BookError::Integrity);
        }
        let mut reachable = [0u64; ARENA_CAPACITY / 64];
        for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
            let count = self.validate_tree(tree, &mut reachable)?;
            if count != self.leaf_counts[tree.index()] {
                return Err(BookError::Integrity);
            }
        }
        let mut free = [0u64; ARENA_CAPACITY / 64];
        let mut cursor = self.free_head;
        let mut free_count = 0u32;
        while cursor != NONE {
            if cursor >= self.bump_index || bit_get(&free, cursor) || bit_get(&reachable, cursor) {
                return Err(BookError::Integrity);
            }
            bit_set(&mut free, cursor);
            free_count += 1;
            cursor = match self.tag(cursor)? {
                TAG_FREE => unsafe { self.nodes[cursor as usize].free.next },
                TAG_LAST_FREE => NONE,
                _ => return Err(BookError::BadTag),
            };
        }
        if free_count != self.free_len {
            return Err(BookError::Integrity);
        }
        for handle in 0..self.bump_index {
            if !bit_get(&reachable, handle) && !bit_get(&free, handle) {
                return Err(BookError::Integrity);
            }
        }
        for handle in self.bump_index as usize..ARENA_CAPACITY {
            if unsafe { self.nodes[handle].inner.tag } != TAG_UNINITIALIZED {
                return Err(BookError::Integrity);
            }
        }
        Ok(())
    }

    pub fn validate_owner_occupancy(&self, occupied: &[bool; 128]) -> Result<(), BookError> {
        let mut handle = 0u32;
        while handle < self.bump_index {
            if self.tag(handle)? == TAG_LEAF {
                let owner = self.leaf(handle)?.owner as usize;
                if owner >= occupied.len() || !occupied[owner] {
                    return Err(BookError::InvalidOwner);
                }
            }
            handle += 1;
        }
        Ok(())
    }

    fn validate_tree(
        &self,
        tree: TreeKind,
        reachable: &mut [u64; ARENA_CAPACITY / 64],
    ) -> Result<u32, BookError> {
        let root = self.roots[tree.index()];
        if root == NONE {
            return Ok(0);
        }
        let mut stack = [(root, NONE, 0u8); 129];
        let mut stack_len = 1usize;
        let mut leaves = 0u32;
        while stack_len > 0 {
            stack_len -= 1;
            let (handle, parent, expected_branch) = stack[stack_len];
            if handle >= self.bump_index || bit_get(reachable, handle) {
                return Err(BookError::Integrity);
            }
            bit_set(reachable, handle);
            let tag = self.tag(handle)?;
            let key = match tag {
                TAG_LEAF => self.leaf(handle)?.key,
                TAG_INNER => self.inner(handle)?.key,
                _ => return Err(BookError::BadTag),
            };
            if parent != NONE {
                let p = self.inner(parent)?;
                if !prefix_matches(p.key, key, p.prefix_len)
                    || key_bit(key, p.prefix_len) != expected_branch
                {
                    return Err(BookError::Integrity);
                }
                if tag == TAG_INNER && self.inner(handle)?.prefix_len <= p.prefix_len {
                    return Err(BookError::Integrity);
                }
            }
            match tag {
                TAG_LEAF => leaves += 1,
                TAG_INNER => {
                    let node = self.inner(handle)?;
                    if node.prefix_len >= 128
                        || node.children[0] == NONE
                        || node.children[1] == NONE
                        || node.child_earliest_expiry
                            != [
                                self.subtree_expiry(node.children[0])?,
                                self.subtree_expiry(node.children[1])?,
                            ]
                        || stack_len + 2 > stack.len()
                    {
                        return Err(BookError::Integrity);
                    }
                    stack[stack_len] = (node.children[0], handle, 0);
                    stack_len += 1;
                    stack[stack_len] = (node.children[1], handle, 1);
                    stack_len += 1;
                }
                _ => return Err(BookError::BadTag),
            }
        }
        Ok(leaves)
    }
}

impl Default for Arena {
    fn default() -> Self {
        Self::new()
    }
}

const _: [(); 90_640] = [(); size_of::<Arena>()];

#[repr(C)]
pub struct MarketState {
    pub layout_version: u16,
    pub _reserved: [u8; 30],
    pub bids: Arena,
    pub asks: Arena,
}

impl MarketState {
    pub const fn new() -> Self {
        Self {
            layout_version: 1,
            _reserved: [0; 30],
            bids: Arena::new(),
            asks: Arena::new(),
        }
    }
    pub fn arena(&self, side: Side) -> &Arena {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }
    pub fn arena_mut(&mut self, side: Side) -> &mut Arena {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }
}

#[derive(Clone, Copy)]
pub struct OrderInput {
    pub side: Side,
    pub tree: TreeKind,
    pub owner: u32,
    pub price_or_offset: i64,
    pub sequence: u64,
    pub quantity: u64,
    pub expires_at: u64,
    pub peg_limit: i64,
    pub client_order_id: u64,
    pub time_in_force: TimeInForce,
    pub post_only: bool,
}

impl OrderInput {
    pub fn leaf(self) -> Result<LeafNode, BookError> {
        let key = match self.tree {
            TreeKind::Fixed => price_time_key(self.side, self.price_or_offset, self.sequence)?,
            TreeKind::OraclePegged => {
                offset_time_key(self.side, self.price_or_offset, self.sequence)?
            }
        };
        Ok(LeafNode {
            tag: TAG_LEAF,
            side: self.side as u8,
            time_in_force: self.time_in_force as u8,
            _padding: 0,
            owner: self.owner,
            key,
            quantity: self.quantity,
            expires_at: self.expires_at,
            peg_limit: self.peg_limit,
            client_order_id: self.client_order_id,
            price_or_offset: self.price_or_offset,
            sequence: self.sequence,
            flags: self.post_only as u8,
            _reserved: [0; 15],
        })
    }
}

pub fn price_time_key(side: Side, price: i64, sequence: u64) -> Result<u128, BookError> {
    if price <= 0 {
        return Err(BookError::BadPrice);
    }
    let normalized = match side {
        Side::Ask => price as u64,
        Side::Bid => u64::MAX
            .checked_sub(price as u64)
            .ok_or(BookError::BadPrice)?,
    };
    Ok(((normalized as u128) << 64) | sequence as u128)
}

fn offset_time_key(side: Side, offset: i64, sequence: u64) -> Result<u128, BookError> {
    let normalized = match side {
        Side::Ask => (offset as u64) ^ (1u64 << 63),
        Side::Bid => !((offset as u64) ^ (1u64 << 63)),
    };
    Ok(((normalized as u128) << 64) | sequence as u128)
}

pub fn pegged_state(leaf: &LeafNode, oracle: Option<i64>, now: u64) -> PeggedState {
    if leaf.quantity == 0 || expiry_of(leaf) <= now {
        return PeggedState::Invalid;
    }
    let Some(oracle) = oracle else {
        return PeggedState::Skipped;
    };
    let Some(price) = oracle.checked_add(leaf.price_or_offset) else {
        return PeggedState::Invalid;
    };
    if price <= 0 {
        return PeggedState::Invalid;
    }
    let side = if leaf.side == Side::Bid as u8 {
        Side::Bid
    } else {
        Side::Ask
    };
    let permitted = match side {
        Side::Bid => price <= leaf.peg_limit,
        Side::Ask => price >= leaf.peg_limit,
    };
    if leaf.peg_limit <= 0 || !permitted {
        PeggedState::Invalid
    } else {
        PeggedState::Valid(price)
    }
}

pub fn normalized_key(
    leaf: &LeafNode,
    tree: TreeKind,
    oracle: Option<i64>,
    now: u64,
) -> Result<Option<u128>, BookError> {
    match tree {
        TreeKind::Fixed => Ok((leaf.quantity != 0 && expiry_of(leaf) > now).then_some(leaf.key)),
        TreeKind::OraclePegged => match pegged_state(leaf, oracle, now) {
            PeggedState::Valid(price) => Ok(Some(price_time_key(
                if leaf.side == 0 { Side::Bid } else { Side::Ask },
                price,
                leaf.sequence,
            )?)),
            PeggedState::Invalid | PeggedState::Skipped => Ok(None),
        },
    }
}

#[derive(Clone, Copy)]
pub struct FillRecord {
    pub maker: u32,
    pub taker: u32,
    pub price: i64,
    pub quantity: u64,
    pub maker_client_order_id: u64,
    pub maker_remaining: u64,
    pub maker_handle: u32,
    pub maker_tree: u8,
}
impl FillRecord {
    const EMPTY: Self = Self {
        maker: 0,
        taker: 0,
        price: 0,
        quantity: 0,
        maker_client_order_id: 0,
        maker_remaining: 0,
        maker_handle: NONE,
        maker_tree: 0,
    };
}
#[derive(Clone, Copy)]
pub struct MatchLimits {
    pub max_fills: u8,
    pub max_invalid_removals: u8,
    pub max_expired_removals: u8,
}
#[derive(Clone, Copy)]
pub struct MatchResult {
    pub fills: [FillRecord; MAX_MATCH_FILLS],
    pub fill_count: u8,
    pub remaining: u64,
    pub invalid_removed: u8,
    pub expired_removed: u8,
    pub self_cancelled: u8,
    pub post_only_rejected: bool,
}

pub const MAX_PLAN_ACTIONS: usize = 16;

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct PlanAction {
    pub handle: u32,
    pub side: Side,
    pub tree: TreeKind,
    pub remove: bool,
    pub new_quantity: u64,
    pub key: u128,
    pub owner: u32,
    pub expected_quantity: u64,
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct PlannedMatch {
    pub fills: [FillRecord; MAX_MATCH_FILLS],
    pub fill_count: u8,
    pub remaining: u64,
    pub invalid_removed: u8,
    pub expired_removed: u8,
    pub self_cancelled: u8,
    pub post_only_rejected: bool,
    pub actions: [PlanAction; MAX_PLAN_ACTIONS],
    pub action_count: u8,
    pub expected_oracle_price: i64,
    pub expected_oracle_timestamp: u64,
    pub expected_funding_accumulator: i128,
    pub expected_event_sequence: u64,
    pub expected_order_sequence: u64,
    pub event_sequence_after: u64,
    pub order_sequence_after: u64,
}

impl PlanAction {
    const EMPTY: Self = Self {
        handle: NONE,
        side: Side::Bid,
        tree: TreeKind::Fixed,
        remove: false,
        new_quantity: 0,
        key: 0,
        owner: 0,
        expected_quantity: 0,
    };
}

const _: [(); core::mem::size_of::<PlanAction>()] = [(); 48];
const _: [(); core::mem::size_of::<PlannedMatch>()] = [(); core::mem::size_of::<PlannedMatch>()];
pub type SettlementPlan = PlannedMatch;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CancelSummary {
    pub count: u8,
    pub bid_quantity: u64,
    pub ask_quantity: u64,
    pub reserved_notional: u128,
}

pub fn match_limit(
    state: &mut MarketState,
    order: OrderInput,
    oracle: Option<i64>,
    now: u64,
    limits: MatchLimits,
) -> Result<MatchResult, BookError> {
    match_limit_arenas(&mut state.bids, &mut state.asks, order, oracle, now, limits)
}

#[inline(never)]
pub fn plan_limit_arenas(
    bids: &Arena,
    asks: &Arena,
    order: OrderInput,
    oracle: Option<i64>,
    now: u64,
    limits: MatchLimits,
) -> Result<PlannedMatch, BookError> {
    let mut plan = PlannedMatch {
        fills: [FillRecord::EMPTY; MAX_MATCH_FILLS],
        fill_count: 0,
        remaining: 0,
        invalid_removed: 0,
        expired_removed: 0,
        self_cancelled: 0,
        post_only_rejected: false,
        actions: [PlanAction::EMPTY; MAX_PLAN_ACTIONS],
        action_count: 0,
        expected_oracle_price: 0,
        expected_oracle_timestamp: 0,
        expected_funding_accumulator: 0,
        expected_event_sequence: 0,
        expected_order_sequence: 0,
        event_sequence_after: 0,
        order_sequence_after: 0,
    };
    plan_limit_arenas_into(bids, asks, order, oracle, now, limits, &mut plan)?;
    Ok(plan)
}

/// Plans into caller-owned memory. Production uses the settlement scratch
/// account; the by-value wrapper above is retained solely for native book tests.
#[inline(never)]
pub fn plan_limit_arenas_into(
    bids: &Arena,
    asks: &Arena,
    order: OrderInput,
    oracle: Option<i64>,
    now: u64,
    limits: MatchLimits,
    mut plan: &mut PlannedMatch,
) -> Result<(), BookError> {
    if order.quantity == 0
        || limits.max_fills as usize > MAX_MATCH_FILLS
        || limits.max_invalid_removals as usize
            + limits.max_expired_removals as usize
            + limits.max_fills as usize
            + 2
            > MAX_PLAN_ACTIONS
    {
        return Err(BookError::BadLimit);
    }
    let taker_price = match order.tree {
        TreeKind::Fixed => order.price_or_offset,
        TreeKind::OraclePegged => oracle
            .and_then(|p| p.checked_add(order.price_or_offset))
            .ok_or(BookError::BadPrice)?,
    };
    if taker_price <= 0 {
        return Err(BookError::BadPrice);
    }
    *plan = PlannedMatch {
        fills: [FillRecord::EMPTY; MAX_MATCH_FILLS],
        fill_count: 0,
        remaining: order.quantity,
        invalid_removed: 0,
        expired_removed: 0,
        self_cancelled: 0,
        post_only_rejected: false,
        actions: [PlanAction::EMPTY; MAX_PLAN_ACTIONS],
        action_count: 0,
        expected_oracle_price: 0,
        expected_oracle_timestamp: 0,
        expected_funding_accumulator: 0,
        expected_event_sequence: 0,
        expected_order_sequence: 0,
        event_sequence_after: 0,
        order_sequence_after: 0,
    };
    let mut virtual_count = 0usize;
    let opposite = match order.side {
        Side::Bid => Side::Ask,
        Side::Ask => Side::Bid,
    };
    let opposing_arena = arena_for_side(bids, asks, opposite);
    let mut cleanup_handle = 0u32;
    while cleanup_handle < opposing_arena.bump_index {
        if opposing_arena.tag(cleanup_handle)? == TAG_LEAF {
            let leaf = opposing_arena.leaf(cleanup_handle)?;
            let mut tree_index = 0usize;
            while tree_index < 2 {
                let tree = if tree_index == 0 {
                    TreeKind::Fixed
                } else {
                    TreeKind::OraclePegged
                };
                if opposing_arena.find(tree, leaf.key) == Ok(cleanup_handle) {
                    let expired = expiry_of(&leaf) <= now;
                    let invalid = match tree {
                        TreeKind::Fixed => leaf.quantity == 0 || expired,
                        TreeKind::OraclePegged => {
                            matches!(pegged_state(&leaf, oracle, now), PeggedState::Invalid)
                        }
                    };
                    if invalid {
                        if expired {
                            if plan.expired_removed >= limits.max_expired_removals {
                                return Err(BookError::BadLimit);
                            }
                            plan.expired_removed += 1;
                        } else {
                            if plan.invalid_removed >= limits.max_invalid_removals {
                                return Err(BookError::BadLimit);
                            }
                            plan.invalid_removed += 1;
                        }
                        add_plan_action(
                            &mut plan,
                            &mut virtual_count,
                            PlanAction {
                                handle: cleanup_handle,
                                side: opposite,
                                tree,
                                remove: true,
                                new_quantity: 0,
                                key: leaf.key,
                                owner: leaf.owner,
                                expected_quantity: leaf.quantity,
                            },
                        )?;
                    }
                }
                tree_index += 1;
            }
        }
        cleanup_handle += 1;
    }
    let mut iterations = 0usize;
    while plan.remaining > 0 && plan.fill_count < limits.max_fills && iterations < MAX_PLAN_ACTIONS
    {
        iterations += 1;
        let Some((tree, handle, leaf, price)) = best_virtual_candidate(
            bids,
            asks,
            opposite,
            oracle,
            now,
            &plan.actions,
            virtual_count,
        )?
        else {
            break;
        };
        let crosses = match order.side {
            Side::Bid => price <= taker_price,
            Side::Ask => price >= taker_price,
        };
        if !crosses {
            break;
        }
        if order.post_only {
            plan.post_only_rejected = true;
            break;
        }
        if leaf.owner == order.owner {
            add_plan_action(
                &mut plan,
                &mut virtual_count,
                PlanAction {
                    handle,
                    side: opposite,
                    tree,
                    remove: true,
                    new_quantity: 0,
                    key: leaf.key,
                    owner: leaf.owner,
                    expected_quantity: leaf.quantity,
                },
            )?;
            plan.self_cancelled = plan.self_cancelled.saturating_add(1);
            continue;
        }
        let amount = leaf.quantity.min(plan.remaining);
        let after = leaf.quantity - amount;
        let fill_index = plan.fill_count as usize;
        plan.fills[fill_index] = FillRecord {
            maker: leaf.owner,
            taker: order.owner,
            price,
            quantity: amount,
            maker_client_order_id: leaf.client_order_id,
            maker_remaining: after,
            maker_handle: handle,
            maker_tree: tree as u8,
        };
        plan.fill_count += 1;
        plan.remaining -= amount;
        add_plan_action(
            &mut plan,
            &mut virtual_count,
            PlanAction {
                handle,
                side: opposite,
                tree,
                remove: after == 0,
                new_quantity: after,
                key: leaf.key,
                owner: leaf.owner,
                expected_quantity: leaf.quantity,
            },
        )?;
    }
    Ok(())
}

fn add_plan_action(
    plan: &mut PlannedMatch,
    virtual_count: &mut usize,
    action: PlanAction,
) -> Result<(), BookError> {
    let mut i = 0usize;
    while i < *virtual_count {
        if plan.actions[i].handle == action.handle && plan.actions[i].tree == action.tree {
            plan.actions[i] = action;
            return Ok(());
        }
        i += 1;
    }
    if *virtual_count >= MAX_PLAN_ACTIONS || plan.action_count as usize >= MAX_PLAN_ACTIONS {
        return Err(BookError::BadLimit);
    }
    plan.actions[plan.action_count as usize] = action;
    plan.action_count += 1;
    *virtual_count += 1;
    Ok(())
}

fn best_virtual_candidate(
    bids: &Arena,
    asks: &Arena,
    side: Side,
    oracle: Option<i64>,
    now: u64,
    virtuals: &[PlanAction; MAX_PLAN_ACTIONS],
    virtual_count: usize,
) -> Result<Option<(TreeKind, u32, LeafNode, i64)>, BookError> {
    let arena = arena_for_side(bids, asks, side);
    let mut selected: Option<(TreeKind, u32, LeafNode, i64, u128)> = None;
    let mut handle = 0u32;
    while handle < arena.bump_index {
        if arena.tag(handle)? != TAG_LEAF {
            handle += 1;
            continue;
        }
        let leaf = arena.leaf(handle)?;
        let mut tree_index = 0usize;
        while tree_index < 2 {
            let tree = if tree_index == 0 {
                TreeKind::Fixed
            } else {
                TreeKind::OraclePegged
            };
            if arena.find(tree, leaf.key) != Ok(handle) {
                tree_index += 1;
                continue;
            }
            let mut quantity = leaf.quantity;
            let mut removed = false;
            let mut i = 0usize;
            while i < virtual_count {
                if virtuals[i].handle == handle && virtuals[i].tree == tree {
                    removed = virtuals[i].remove;
                    quantity = virtuals[i].new_quantity;
                    break;
                }
                i += 1;
            }
            if removed || quantity == 0 {
                tree_index += 1;
                continue;
            }
            let mut candidate = leaf;
            candidate.quantity = quantity;
            let Some(normalized) = normalized_key(&candidate, tree, oracle, now)? else {
                tree_index += 1;
                continue;
            };
            let price = match tree {
                TreeKind::Fixed => candidate.price_or_offset,
                TreeKind::OraclePegged => match pegged_state(&candidate, oracle, now) {
                    PeggedState::Valid(price) => price,
                    PeggedState::Invalid | PeggedState::Skipped => {
                        tree_index += 1;
                        continue;
                    }
                },
            };
            if selected.map(|x| normalized < x.4).unwrap_or(true) {
                selected = Some((tree, handle, candidate, price, normalized));
            }
            tree_index += 1;
        }
        handle += 1;
    }
    Ok(selected.map(|(tree, handle, leaf, price, _)| (tree, handle, leaf, price)))
}

pub fn match_limit_arenas(
    bids: &mut Arena,
    asks: &mut Arena,
    order: OrderInput,
    oracle: Option<i64>,
    now: u64,
    limits: MatchLimits,
) -> Result<MatchResult, BookError> {
    if order.quantity == 0 || limits.max_fills as usize > MAX_MATCH_FILLS {
        return Err(BookError::BadLimit);
    }
    let opposite = match order.side {
        Side::Bid => Side::Ask,
        Side::Ask => Side::Bid,
    };
    let taker_price = match order.tree {
        TreeKind::Fixed => order.price_or_offset,
        TreeKind::OraclePegged => match oracle.and_then(|p| p.checked_add(order.price_or_offset)) {
            Some(p) if p > 0 => p,
            _ => return Err(BookError::BadPrice),
        },
    };
    let mut result = MatchResult {
        fills: [FillRecord::EMPTY; MAX_MATCH_FILLS],
        fill_count: 0,
        remaining: order.quantity,
        invalid_removed: 0,
        expired_removed: 0,
        self_cancelled: 0,
        post_only_rejected: false,
    };
    for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
        result.expired_removed = result.expired_removed.saturating_add(
            arena_mut_for_side(bids, asks, opposite).sweep_expired(
                tree,
                now,
                limits
                    .max_expired_removals
                    .saturating_sub(result.expired_removed),
            )?,
        );
    }
    let mut iterations = 0u16;
    while result.remaining > 0
        && result.fill_count < limits.max_fills
        && iterations
            < (limits.max_fills as u16
                + limits.max_invalid_removals as u16
                + limits.max_expired_removals as u16
                + 2)
    {
        iterations += 1;
        let mut removed_invalid = false;
        for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
            let Some(handle) = arena_for_side(bids, asks, opposite).best(tree)? else {
                continue;
            };
            let leaf = arena_for_side(bids, asks, opposite).leaf(handle)?;
            let invalid = match tree {
                TreeKind::Fixed => leaf.quantity == 0 || expiry_of(&leaf) <= now,
                TreeKind::OraclePegged => {
                    matches!(pegged_state(&leaf, oracle, now), PeggedState::Invalid)
                }
            };
            if invalid {
                if result.invalid_removed >= limits.max_invalid_removals {
                    continue;
                }
                arena_mut_for_side(bids, asks, opposite).remove(tree, leaf.key)?;
                result.invalid_removed += 1;
                removed_invalid = true;
                break;
            }
        }
        if removed_invalid {
            continue;
        }
        let candidate =
            best_candidate(arena_for_side(bids, asks, opposite), opposite, oracle, now)?;
        let Some((tree, handle, maker, price)) = candidate else {
            break;
        };
        let crosses = match order.side {
            Side::Bid => price <= taker_price,
            Side::Ask => price >= taker_price,
        };
        if !crosses {
            break;
        }
        if order.post_only {
            result.post_only_rejected = true;
            break;
        }
        if maker.owner == order.owner {
            arena_mut_for_side(bids, asks, opposite).remove(tree, maker.key)?;
            result.self_cancelled = result.self_cancelled.saturating_add(1);
            continue;
        }
        let amount = maker.quantity.min(result.remaining);
        result.fills[result.fill_count as usize] = FillRecord {
            maker: maker.owner,
            taker: order.owner,
            price,
            quantity: amount,
            maker_client_order_id: maker.client_order_id,
            maker_remaining: 0,
            maker_handle: handle,
            maker_tree: tree as u8,
        };
        result.fill_count += 1;
        result.remaining -= amount;
        if amount == maker.quantity {
            arena_mut_for_side(bids, asks, opposite).remove(tree, maker.key)?;
        } else {
            let mut changed = maker;
            changed.quantity -= amount;
            arena_mut_for_side(bids, asks, opposite).write_leaf(handle, changed);
            result.fills[result.fill_count as usize - 1].maker_remaining = changed.quantity;
        }
    }
    if result.remaining > 0
        && order.time_in_force != TimeInForce::ImmediateOrCancel
        && !result.post_only_rejected
    {
        let mut resting = order;
        resting.quantity = result.remaining;
        arena_mut_for_side(bids, asks, order.side).insert(resting.tree, resting.leaf()?)?;
    }
    Ok(result)
}

fn arena_for_side<'a>(bids: &'a Arena, asks: &'a Arena, side: Side) -> &'a Arena {
    match side {
        Side::Bid => bids,
        Side::Ask => asks,
    }
}

fn arena_mut_for_side<'a>(bids: &'a mut Arena, asks: &'a mut Arena, side: Side) -> &'a mut Arena {
    match side {
        Side::Bid => bids,
        Side::Ask => asks,
    }
}

fn best_candidate(
    arena: &Arena,
    side: Side,
    oracle: Option<i64>,
    now: u64,
) -> Result<Option<(TreeKind, u32, LeafNode, i64)>, BookError> {
    let mut selected: Option<(TreeKind, u32, LeafNode, i64, u128)> = None;
    for tree in [TreeKind::Fixed, TreeKind::OraclePegged] {
        let Some(handle) = arena.best(tree)? else {
            continue;
        };
        let leaf = arena.leaf(handle)?;
        let price = match tree {
            TreeKind::Fixed if leaf.quantity != 0 && expiry_of(&leaf) > now => leaf.price_or_offset,
            TreeKind::Fixed => continue,
            TreeKind::OraclePegged => match pegged_state(&leaf, oracle, now) {
                PeggedState::Valid(price) => price,
                PeggedState::Invalid => continue,
                PeggedState::Skipped => continue,
            },
        };
        let key = price_time_key(side, price, leaf.sequence)?;
        if selected.map(|x| key < x.4).unwrap_or(true) {
            selected = Some((tree, handle, leaf, price, key));
        }
    }
    Ok(selected.map(|(tree, handle, leaf, price, _)| (tree, handle, leaf, price)))
}

fn make_inner(
    prefix_len: u32,
    key: u128,
    existing: u32,
    fresh: u32,
    fresh_branch: usize,
) -> InnerNode {
    let mut children = [existing; 2];
    children[fresh_branch] = fresh;
    InnerNode {
        tag: TAG_INNER,
        _padding: [0; 3],
        prefix_len,
        key,
        children,
        child_earliest_expiry: [NO_EXPIRY; 2],
        _reserved: [0; 40],
    }
}
fn key_bit(key: u128, prefix: u32) -> u8 {
    ((key >> (127 - prefix)) & 1) as u8
}
fn common_prefix(a: u128, b: u128) -> u32 {
    (a ^ b).leading_zeros()
}
fn prefix_matches(a: u128, b: u128, prefix: u32) -> bool {
    prefix == 0 || (a >> (128 - prefix)) == (b >> (128 - prefix))
}
fn expiry_of(leaf: &LeafNode) -> u64 {
    if leaf.expires_at == 0 {
        NO_EXPIRY
    } else {
        leaf.expires_at
    }
}
fn bit_get(bits: &[u64; ARENA_CAPACITY / 64], handle: u32) -> bool {
    bits[handle as usize / 64] & (1 << (handle % 64)) != 0
}
fn bit_set(bits: &mut [u64; ARENA_CAPACITY / 64], handle: u32) {
    bits[handle as usize / 64] |= 1 << (handle % 64);
}
