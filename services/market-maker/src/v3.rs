//! StockStream V3 market layout: the 27-account execution bundle, the
//! order instructions the maker sends (byte-compatible with
//! clients/stockstream), and decoders for the accounts it reads.

use crate::quotes::{RestingOrder, Side};
use crate::solana::{find_program_address, AccountMeta, Instruction, Pubkey};

pub const BOOK_PAGES_PER_SIDE: u8 = 9;
const BOOK_PAGE_SIZE: usize = 10_184;
const BOOK_PAGE_HEADER: usize = 64;
const NODE_SIZE: usize = 88;
const NODES_PER_PAGE: usize = 115;
const SEAT_SHARD_SIZE: usize = 8_236;
const SEAT_SHARD_HEADER: usize = 44;
const SEAT_SIZE: usize = 256;
const SEATS_PER_SHARD: usize = 32;
const LAYOUT_VERSION: u16 = 3;
/// OracleSnapshotV3: verified price (raw, exponent -5) and publish time.
const SNAPSHOT_PRICE_OFFSET: usize = 53;
const SNAPSHOT_PUBLISH_OFFSET: usize = 69;
/// Pyth trading status the program enforces: only OPEN (0) accepts orders.
const SNAPSHOT_STATUS_OFFSET: usize = 86;

const OP_PLACE_ORDER: u8 = 3;
const OP_CANCEL_ORDER: u8 = 4;
const OP_REPLACE_ORDER: u8 = 33;

#[derive(Clone)]
pub struct Bundle {
    pub program: Pubkey,
    pub core: Pubkey,
    pub book_pages: Vec<Pubkey>,
    pub seat_shards: Vec<Pubkey>,
    pub event_shards: Vec<Pubkey>,
    pub oracle_snapshot: Pubkey,
}

impl Bundle {
    pub fn derive(program: Pubkey, core: Pubkey, oracle_snapshot: Pubkey) -> Self {
        let pda = |seed: &str, suffix: &[u8]| find_program_address(&[seed.as_bytes(), &core, suffix], &program);
        Self {
            program,
            core,
            book_pages: (0..2 * BOOK_PAGES_PER_SIDE).map(|flat| pda("book-page-v3", &[flat / BOOK_PAGES_PER_SIDE, flat % BOOK_PAGES_PER_SIDE])).collect(),
            seat_shards: (0..4u8).map(|shard| pda("seat-shard-v3", &[shard])).collect(),
            event_shards: (0..4u8).map(|shard| pda("event-shard-v3", &[shard])).collect(),
            oracle_snapshot,
        }
    }

    /// Execution metas in program order: the bundle writable, then the signer and the snapshot.
    fn metas(&self, authority: &Pubkey) -> Vec<AccountMeta> {
        let writable = |pubkey: &Pubkey| AccountMeta { pubkey: *pubkey, is_signer: false, is_writable: true };
        std::iter::once(&self.core)
            .chain(&self.book_pages)
            .chain(&self.seat_shards)
            .chain(&self.event_shards)
            .map(writable)
            .chain([
                AccountMeta { pubkey: *authority, is_signer: true, is_writable: false },
                AccountMeta { pubkey: self.oracle_snapshot, is_signer: false, is_writable: false },
            ])
            .collect()
    }
}

pub struct OrderInput {
    pub seat: u16,
    pub side: Side,
    pub quantity: u64,
    pub price: i64,
    pub expires_at: u64,
    pub client_order_id: u64,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
}

/// PlaceOrderV3 body after the opcode (fixed-price tree, main-wallet nonce 0).
fn order_body(order: &OrderInput) -> Vec<u8> {
    let mut data = Vec::with_capacity(53);
    data.push(match order.side { Side::Bid => 0, Side::Ask => 1 });
    data.push(0); // fixed-price tree
    data.push(u8::from(order.post_only) | (u8::from(order.immediate_or_cancel) << 1));
    data.extend_from_slice(&order.seat.to_le_bytes());
    data.extend_from_slice(&order.quantity.to_le_bytes());
    data.extend_from_slice(&order.price.to_le_bytes());
    data.extend_from_slice(&order.expires_at.to_le_bytes());
    data.extend_from_slice(&0i64.to_le_bytes()); // peg limit
    data.extend_from_slice(&order.client_order_id.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // action nonce
    data
}

pub fn place_order(bundle: &Bundle, authority: &Pubkey, order: &OrderInput) -> Instruction {
    let mut data = vec![OP_PLACE_ORDER];
    data.extend(order_body(order));
    Instruction { program_id: bundle.program, accounts: bundle.metas(authority), data }
}

/// ReplaceOrderV3: atomically cancels `old_key` and places the new order.
pub fn replace_order(bundle: &Bundle, authority: &Pubkey, old_key: u128, order: &OrderInput) -> Instruction {
    let mut data = vec![OP_REPLACE_ORDER];
    data.extend_from_slice(&old_key.to_le_bytes());
    data.extend(order_body(order));
    Instruction { program_id: bundle.program, accounts: bundle.metas(authority), data }
}

pub fn cancel_order(bundle: &Bundle, authority: &Pubkey, seat: u16, key: u128) -> Instruction {
    let mut data = vec![OP_CANCEL_ORDER];
    data.extend_from_slice(&seat.to_le_bytes());
    data.extend_from_slice(&key.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction { program_id: bundle.program, accounts: bundle.metas(authority), data }
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"))
}
fn i128_at(bytes: &[u8], offset: usize) -> i128 {
    i128::from_le_bytes(bytes[offset..offset + 16].try_into().expect("16 bytes"))
}
fn valid(bytes: &[u8], discriminator: &[u8; 8], size: usize) -> bool {
    bytes.len() == size && &bytes[0..8] == discriminator && u16::from_le_bytes([bytes[8], bytes[9]]) == LAYOUT_VERSION
}

/// Resting leaves on one book page owned by `seat`.
pub fn resting_orders(page: &[u8], seat: u16) -> Vec<RestingOrder> {
    if !valid(page, b"STKBK003", BOOK_PAGE_SIZE) {
        return vec![];
    }
    (0..NODES_PER_PAGE)
        .map(|i| &page[BOOK_PAGE_HEADER + i * NODE_SIZE..BOOK_PAGE_HEADER + (i + 1) * NODE_SIZE])
        .filter(|node| node[0] == 2 && u32::from_le_bytes(node[4..8].try_into().expect("4 bytes")) == u32::from(seat))
        .map(|node| RestingOrder {
            key: u128::from_le_bytes(node[8..24].try_into().expect("16 bytes")),
            side: if node[1] == 0 { Side::Bid } else { Side::Ask },
            quantity: u64_at(node, 24),
            expires_at: u64_at(node, 32),
            price: u64_at(node, 56) as i64,
        })
        .collect()
}

#[derive(Clone, Debug)]
pub struct SeatPosition {
    pub index: u16,
    pub trader: Pubkey,
    pub base_position: i128,
}

pub fn seat_positions(shard: &[u8]) -> Vec<SeatPosition> {
    if !valid(shard, b"STKST003", SEAT_SHARD_SIZE) || shard[10] >= 4 || shard[11] != 0 {
        return vec![];
    }
    (0..SEATS_PER_SHARD)
        .filter_map(|slot| {
            let seat = &shard[SEAT_SHARD_HEADER + slot * SEAT_SIZE..SEAT_SHARD_HEADER + (slot + 1) * SEAT_SIZE];
            (seat[0] != 0).then(|| SeatPosition {
                index: u16::from(shard[10]) * SEATS_PER_SHARD as u16 + slot as u16,
                trader: seat[1..33].try_into().expect("32 bytes"),
                base_position: i128_at(seat, 72),
            })
        })
        .collect()
}

pub struct Snapshot {
    pub price: i64,
    pub published: u64,
    /// The US session is open (pre-market through after-hours); otherwise the program refuses orders.
    pub open: bool,
}

pub fn snapshot(bytes: &[u8]) -> Option<Snapshot> {
    (bytes.len() > SNAPSHOT_STATUS_OFFSET).then(|| Snapshot {
        price: u64_at(bytes, SNAPSHOT_PRICE_OFFSET) as i64,
        published: u64_at(bytes, SNAPSHOT_PUBLISH_OFFSET),
        open: bytes[SNAPSHOT_STATUS_OFFSET] == 0,
    })
}
