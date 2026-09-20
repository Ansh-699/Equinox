//! Real MagicBlock Ephemeral Rollup lifecycle CPIs.
//!
//! StockStream is a `no_std`, no-heap Pinocchio 0.11.2 program. The official
//! `ephemeral-rollups-sdk` (0.17.0) client helpers are Anchor/`solana_program`
//! `AccountInfo`-shaped, and its own instruction/args encoding pulls in `Vec`
//! and (for `magicblock-magic-program-api`) `std::collections::HashMap`,
//! neither of which this program can link (see the `default_panic_handler!`
//! note in `lib.rs`: even the *dependency graph* pulling in `std` was enough
//! to collide with a `no_std` panic handler). Rather than depend on those
//! code paths on-chain, this module hand-encodes the exact wire bytes the
//! delegation program and Magic program expect, verified byte-for-byte in
//! `tests/magicblock.rs` against the real `magicblock-delegation-program-api`
//! (`dlp_api`, `=3.1.0`) and `magicblock-magic-program-api` (`=0.10.1`)
//! crates' own `borsh`/`bincode` serialization (golden vectors), and against
//! the actual `magicblock-labs/delegation-program` `processor/fast/*.rs`
//! source (account order, signer/writable flags, the external-undelegate
//! callback contract) fetched from GitHub during implementation. Program
//! IDs, PDA seed tags and the external-undelegate discriminator are taken
//! directly from `dlp_api` constants -- nothing here is guessed.
//!
//! The delegated hot cluster is the market PDA plus every other StockStream
//! account a trading instruction writes inside the same ER execution domain:
//! per-active-seat settlement scratch PDAs (`Empty` at every boundary, no
//! in-flight plan may cross delegation) and session-signed trading's
//! `TradingSession` PDAs (session nonce/notional consumption). Each member is
//! delegated by the same Delegation-Program `Delegate` CPI looped per account
//! (own buffer/record/metadata PDAs, own borsh seeds payload); the commit
//! intent bundle commits the whole cluster in one intent. Mixed writable
//! domains (a delegated account plus a non-delegated writable one in the same
//! transaction) are rejected by the ER runtime, which is why the cluster is
//! delegated as one unit.

use core::mem::{size_of, MaybeUninit};

use pinocchio::{
    cpi::{invoke_signed, invoke_signed_with_bounds, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::StockStreamError,
    handlers::{custom, event_timestamp, initialized_header, market_data, write_header},
    registry::{INSTRUMENT_DISCRIMINATOR, INSTRUMENT_SIZE, PERP_MARKET_SEED},
    scratch::{
        derive_settlement_scratch, ScratchStatus, SettlementScratchHeader, SETTLEMENT_SCRATCH_LEN,
    },
    session, state,
    state::DelegationStatus,
    v3,
};

use crate::scratch;

// ---------------------------------------------------------------------
// Ground-truth constants (see docs/magicblock.md).
// ---------------------------------------------------------------------

/// `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, the official MagicBlock
/// Delegation Program.
///
/// Hand-encoded raw bytes rather than `dlp_api::fast::ID`: linking the
/// published API crate into the SBF binary drags in its std-linked
/// `solana-program` graph, and linking std makes the linker tag the ELF
/// `ELFOSABI_GNU` -- a header the SBF loader rejects outright
/// (`solana-sbpf`'s `ElfError::WrongAbi`). `tests/magicblock.rs` asserts
/// these exact bytes equal `dlp_api::fast::ID`, so the local literal cannot
/// silently drift from the pinned official crate.
pub const DELEGATION_PROGRAM_ID: Address = Address::new_from_array([
    181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229,
    25, 152, 204, 98, 126, 24, 147, 128, 167, 62,
]);

/// `Magic11111111111111111111111111111111111111`, the MagicBlock Magic
/// Program. `magicblock-magic-program-api` only exposes this as its own
/// compat `Pubkey` type; the raw bytes are asserted equal to
/// `magicblock_magic_program_api::id()` in `tests/magicblock.rs`.
pub const MAGIC_PROGRAM_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 176, 218, 112, 149, 236, 185, 214, 222, 195, 119, 215, 40, 145, 182, 231, 142,
    146, 234, 18, 214, 223, 187, 58, 64, 0, 0, 0, 0,
]);

/// `MagicContext1111111111111111111111111111111`, asserted against
/// `magicblock_magic_program_api::MAGIC_CONTEXT_PUBKEY` in tests.
pub const MAGIC_CONTEXT_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 196, 165, 40, 191, 95, 180, 3, 47, 68, 82, 130, 142, 187, 56, 171, 193, 210,
    220, 151, 247, 63, 139, 148, 84, 128, 0, 0, 0,
]);

/// The delegation program's required external-undelegate callback
/// discriminator (`dlp_api::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`,
/// asserted in `tests/magicblock.rs`).
pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];

// PDA seed tags, hand-encoded from `dlp_api::pda::*` (all asserted in
// `tests/magicblock.rs` so none can drift from the pinned crate).
pub const DELEGATION_RECORD_TAG: &[u8] = b"delegation";
pub const DELEGATION_METADATA_TAG: &[u8] = b"delegation-metadata";
pub const DELEGATE_BUFFER_TAG: &[u8] = b"buffer";
pub const UNDELEGATE_BUFFER_TAG: &[u8] = b"undelegate-buffer";

/// Required commit interval: `commit_frequency_ms` must be exactly this.
pub const COMMIT_INTERVAL_MS: u32 = 30_000;

/// `dlp_api::discriminator::DlpDiscriminator::Delegate as u64`.
const DELEGATE_DISCRIMINATOR: u64 = 0;

// ---------------------------------------------------------------------
// Fixed-size wire encoders (no heap allocation). See tests/magicblock.rs for
// the golden-vector cross-check against the real crates' own serializers.
// ---------------------------------------------------------------------

pub const SEEDS_LEN: usize = 4 + (4 + PERP_MARKET_SEED.len()) + (4 + 32);
/// `discriminator(8) + commit_frequency_ms(4) + seeds(SEEDS_LEN) + Some-tag(1) + validator(32)`.
pub const DELEGATE_INSTRUCTION_DATA_LEN: usize = 8 + 4 + SEEDS_LEN + 1 + 32;
/// Upper bound over all three seed payloads.
pub const DELEGATE_INSTRUCTION_DATA_MAX_LEN: usize = 8 + 4 + MAX_SEEDS_PAYLOAD_LEN + 1 + 32;
/// Borsh `Vec<Vec<u8>>` of the market's own delegation seeds.
/// `4 + (4+11) + (4+32)`.
pub const MARKET_SEEDS_PAYLOAD_LEN: usize = SEEDS_LEN;
/// Borsh `vec![b"settlement"(10), market(32), seat_le(2)]`:
/// `4 + (4+10) + (4+32) + (4+2)`.
pub const SCRATCH_SEEDS_PAYLOAD_LEN: usize = 4 + (4 + 10) + (4 + 32) + (4 + 2);
/// Borsh `vec![b"trading_session", owner(32), market(32), seat_le(2),
/// session_signer(32)]`: `4 + (4+15) + (4+32) + (4+32) + (4+2) + (4+32)`.
pub const SESSION_SEEDS_PAYLOAD_LEN: usize =
    4 + (4 + 15) + (4 + 32) + (4 + 32) + (4 + 2) + (4 + 32);
/// V3 core: `vec![b"market-v3", instrument]`.
pub const V3_CORE_SEEDS_PAYLOAD_LEN: usize = 4 + (4 + 9) + (4 + 32);
/// V3 book page: `vec![b"book-page-v3", core, side, page]`.
pub const V3_BOOK_PAGE_SEEDS_PAYLOAD_LEN: usize = 4 + (4 + 12) + (4 + 32) + (4 + 1) + (4 + 1);
/// V3 seat shard: `vec![b"seat-shard-v3", core, shard]`.
pub const V3_SEAT_SHARD_SEEDS_PAYLOAD_LEN: usize = 4 + (4 + 13) + (4 + 32) + (4 + 1);
/// V3 event shard: `vec![b"event-shard-v3", core, shard]`.
pub const V3_EVENT_SHARD_SEEDS_PAYLOAD_LEN: usize = 4 + (4 + 14) + (4 + 32) + (4 + 1);
/// Largest of the three seed payloads; upper bound for the fixed callback
/// buffer.
pub const MAX_SEEDS_PAYLOAD_LEN: usize = const {
    let m = if MARKET_SEEDS_PAYLOAD_LEN > SCRATCH_SEEDS_PAYLOAD_LEN {
        MARKET_SEEDS_PAYLOAD_LEN
    } else {
        SCRATCH_SEEDS_PAYLOAD_LEN
    };
    if m > SESSION_SEEDS_PAYLOAD_LEN {
        m
    } else {
        SESSION_SEEDS_PAYLOAD_LEN
    }
};
/// `EXTERNAL_UNDELEGATE_DISCRIMINATOR(8) || seeds(<variable>)`; the length
/// selects which delegated account kind the callback restores (8 + 55 market,
/// 8 + 60 scratch, 8 + 137 session). This constant is the maximum.
pub const EXTERNAL_UNDELEGATE_DATA_LEN: usize = 8 + MAX_SEEDS_PAYLOAD_LEN;

/// Borsh encoding of `vec![b"perp-market".to_vec(), instrument.to_vec()]`,
/// i.e. the `seeds` field of `dlp_api::args::DelegateArgs`. This is also
/// exactly the payload the delegation program replays back in the
/// external-undelegate callback (`DelegationMetadata::seeds`), so the same
/// encoder verifies both directions.
pub fn encode_market_delegate_seeds(instrument: &Address) -> [u8; SEEDS_LEN] {
    let mut out = [0u8; SEEDS_LEN];
    out[0..4].copy_from_slice(&2u32.to_le_bytes());
    let mut offset = 4;
    out[offset..offset + 4].copy_from_slice(&(PERP_MARKET_SEED.len() as u32).to_le_bytes());
    offset += 4;
    out[offset..offset + PERP_MARKET_SEED.len()].copy_from_slice(PERP_MARKET_SEED);
    offset += PERP_MARKET_SEED.len();
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 32].copy_from_slice(instrument.as_ref());
    out
}

/// Full `Delegate` (discriminator 0) instruction data for the delegation
/// program: `u64 discriminator || borsh(DelegateArgs)`.
pub fn encode_delegate_instruction_data(
    instrument: &Address,
    validator: &Address,
) -> [u8; DELEGATE_INSTRUCTION_DATA_LEN] {
    let mut out = [0u8; DELEGATE_INSTRUCTION_DATA_LEN];
    out[0..8].copy_from_slice(&DELEGATE_DISCRIMINATOR.to_le_bytes());
    out[8..12].copy_from_slice(&COMMIT_INTERVAL_MS.to_le_bytes());
    out[12..12 + SEEDS_LEN].copy_from_slice(&encode_market_delegate_seeds(instrument));
    let mut offset = 12 + SEEDS_LEN;
    out[offset] = 1; // Option::Some
    offset += 1;
    out[offset..offset + 32].copy_from_slice(validator.as_ref());
    out
}

/// Borsh `vec![b"settlement", market, seat_le]` for a settlement-scratch PDA
/// (`scratch::SETTLEMENT_SEED`, the market PDA's address, the seat index the
/// scratch header carries). Replayed byte-exactly by the external-undelegate
/// callback.
pub fn encode_scratch_delegate_seeds(
    market: &Address,
    seat: u16,
) -> [u8; SCRATCH_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; SCRATCH_SEEDS_PAYLOAD_LEN];
    out[0..4].copy_from_slice(&3u32.to_le_bytes());
    let mut offset = 4;
    out[offset..offset + 4].copy_from_slice(&(scratch::SETTLEMENT_SEED.len() as u32).to_le_bytes());
    offset += 4;
    out[offset..offset + scratch::SETTLEMENT_SEED.len()].copy_from_slice(scratch::SETTLEMENT_SEED);
    offset += scratch::SETTLEMENT_SEED.len();
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 32].copy_from_slice(market.as_ref());
    offset += 32;
    out[offset..offset + 4].copy_from_slice(&2u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 2].copy_from_slice(&seat.to_le_bytes());
    out
}

/// Borsh `vec![b"trading_session", owner, market, seat_le, session_signer]`
/// for a `TradingSession` PDA (`session::TRADING_SESSION_SEED` plus the exact
/// tuple inside the session account). Replayed byte-exactly by the
/// external-undelegate callback.
pub fn encode_session_delegate_seeds(
    owner: &Address,
    market: &Address,
    seat: u16,
    session_signer: &Address,
) -> [u8; SESSION_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; SESSION_SEEDS_PAYLOAD_LEN];
    out[0..4].copy_from_slice(&5u32.to_le_bytes());
    let mut offset = 4;
    out[offset..offset + 4]
        .copy_from_slice(&(session::TRADING_SESSION_SEED.len() as u32).to_le_bytes());
    offset += 4;
    out[offset..offset + session::TRADING_SESSION_SEED.len()]
        .copy_from_slice(session::TRADING_SESSION_SEED);
    offset += session::TRADING_SESSION_SEED.len();
    for value in [owner.as_ref(), market.as_ref()] {
        out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
        offset += 4;
        out[offset..offset + 32].copy_from_slice(value);
        offset += 32;
    }
    out[offset..offset + 4].copy_from_slice(&2u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 2].copy_from_slice(&seat.to_le_bytes());
    offset += 2;
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 32].copy_from_slice(session_signer.as_ref());
    out
}

fn encode_v3_seed_prefix(out: &mut [u8], tag: &[u8], market: &Address, trailing: &[u8]) {
    let count = if trailing.len() == 2 { 4u32 } else { 3u32 };
    out[0..4].copy_from_slice(&count.to_le_bytes());
    let mut offset = 4;
    out[offset..offset + 4].copy_from_slice(&(tag.len() as u32).to_le_bytes());
    offset += 4;
    out[offset..offset + tag.len()].copy_from_slice(tag);
    offset += tag.len();
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    offset += 4;
    out[offset..offset + 32].copy_from_slice(market.as_ref());
    offset += 32;
    for value in trailing {
        out[offset..offset + 4].copy_from_slice(&1u32.to_le_bytes());
        offset += 4;
        out[offset] = *value;
        offset += 1;
    }
}

pub fn encode_v3_core_delegate_seeds(instrument: &Address) -> [u8; V3_CORE_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; V3_CORE_SEEDS_PAYLOAD_LEN];
    out[0..4].copy_from_slice(&2u32.to_le_bytes());
    out[4..8].copy_from_slice(&(v3::V3_MARKET_CORE_SEED.len() as u32).to_le_bytes());
    out[8..8 + v3::V3_MARKET_CORE_SEED.len()].copy_from_slice(v3::V3_MARKET_CORE_SEED);
    let offset = 8 + v3::V3_MARKET_CORE_SEED.len();
    out[offset..offset + 4].copy_from_slice(&32u32.to_le_bytes());
    out[offset + 4..offset + 36].copy_from_slice(instrument.as_ref());
    out
}

pub fn encode_v3_book_page_delegate_seeds(
    core: &Address,
    side: u8,
    page: u8,
) -> [u8; V3_BOOK_PAGE_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; V3_BOOK_PAGE_SEEDS_PAYLOAD_LEN];
    encode_v3_seed_prefix(&mut out, v3::V3_BOOK_PAGE_SEED, core, &[side, page]);
    out
}

pub fn encode_v3_seat_shard_delegate_seeds(
    core: &Address,
    shard: u8,
) -> [u8; V3_SEAT_SHARD_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; V3_SEAT_SHARD_SEEDS_PAYLOAD_LEN];
    encode_v3_seed_prefix(&mut out, v3::V3_SEAT_SHARD_SEED, core, &[shard]);
    out
}

pub fn encode_v3_event_shard_delegate_seeds(
    core: &Address,
    shard: u8,
) -> [u8; V3_EVENT_SHARD_SEEDS_PAYLOAD_LEN] {
    let mut out = [0u8; V3_EVENT_SHARD_SEEDS_PAYLOAD_LEN];
    encode_v3_seed_prefix(&mut out, v3::V3_EVENT_SHARD_SEED, core, &[shard]);
    out
}

/// What a `DelegateArgs::seeds` payload identifies. `Vec<Vec<u8>>` seed lists
/// are parsed from the fixed encoded payload so the external-undelegate
/// callback can route the restore to the right account kind without heap
/// allocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DelegatedAccountKind {
    /// `["perp-market", instrument]`, 2 seeds, payload len `SEEDS_LEN`.
    Market,
    /// `["settlement", market, seat_le]`, 3 seeds,
    /// payload len `SCRATCH_SEEDS_PAYLOAD_LEN`.
    Scratch {
        market: Address,
        seat: u16,
    },
    /// `["trading_session", owner, market, seat_le, session_signer]`,
    /// 5 seeds, payload len `SESSION_SEEDS_PAYLOAD_LEN`.
    Session {
        owner: Address,
        market: Address,
        seat: u16,
        session_signer: Address,
    },
    V3Core {
        instrument: Address,
    },
    V3BookPage {
        core: Address,
        side: u8,
        page: u8,
    },
    V3SeatShard {
        core: Address,
        shard: u8,
    },
    V3EventShard {
        core: Address,
        shard: u8,
    },
}

/// Parses a borsh `Vec<Vec<u8>>` delegation-seeds payload (as replayed by the
/// delegation program's external-undelegate callback) into a
/// `DelegatedAccountKind`. Returns `None` for any payload that does not match
/// one of this program's three delegated account shapes exactly.
pub fn parse_delegated_seeds(payload: &[u8]) -> Option<DelegatedAccountKind> {
    let read_u32 = |offset: usize| -> Option<u32> {
        payload
            .get(offset..offset + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let read_address = |offset: usize| -> Option<Address> {
        let bytes: [u8; 32] = payload.get(offset..offset + 32)?.try_into().ok()?;
        Some(Address::new_from_array(bytes))
    };
    let expect_vec = |offset: usize, expected: &[u8]| -> Option<usize> {
        let len = read_u32(offset)? as usize;
        let start = offset + 4;
        payload
            .get(start..start + len)?
            .eq(expected)
            .then(|| start + len)
    };
    let count = read_u32(0)?;
    if count == 2 && payload.len() == MARKET_SEEDS_PAYLOAD_LEN {
        // ["perp-market", instrument]
        let tag_len = read_u32(4)? as usize;
        if tag_len != PERP_MARKET_SEED.len() || &payload[8..8 + tag_len] != PERP_MARKET_SEED {
            return None;
        }
        let market_start = 8 + tag_len;
        let market_len = read_u32(market_start)? as usize;
        if market_len != 32 || payload.len() != market_start + 4 + 32 {
            return None;
        }
        let instrument = read_address(market_start + 4)?;
        let mut market_seeds = [0u8; MARKET_SEEDS_PAYLOAD_LEN];
        market_seeds.copy_from_slice(&encode_market_delegate_seeds(&instrument));
        if market_seeds.as_slice() != payload {
            return None;
        }
        return Some(DelegatedAccountKind::Market);
    }
    if count == 3 && payload.len() == SCRATCH_SEEDS_PAYLOAD_LEN {
        // ["settlement", market, seat_le]
        let mut offset = expect_vec(4, scratch::SETTLEMENT_SEED)?;
        let market_len = read_u32(offset)? as usize;
        if market_len != 32 {
            return None;
        }
        offset += 4;
        let market = read_address(offset)?;
        offset += 32;
        let seat_len = read_u32(offset)? as usize;
        let seat_bytes = payload.get(offset + 4..offset + 6)?;
        if seat_len != 2 {
            return None;
        }
        let seat = u16::from_le_bytes([seat_bytes[0], seat_bytes[1]]);
        return Some(DelegatedAccountKind::Scratch { market, seat });
    }
    if count == 5 && payload.len() == SESSION_SEEDS_PAYLOAD_LEN {
        // ["trading_session", owner(32), market(32), seat_le(2), session_signer(32)]
        let mut offset = expect_vec(4, session::TRADING_SESSION_SEED)?;
        let owner_len = read_u32(offset)? as usize;
        if owner_len != 32 {
            return None;
        }
        offset += 4;
        let owner = read_address(offset)?;
        offset += 32;
        let market_len = read_u32(offset)? as usize;
        if market_len != 32 {
            return None;
        }
        offset += 4;
        let market = read_address(offset)?;
        offset += 32;
        let seat_len = read_u32(offset)? as usize;
        if seat_len != 2 {
            return None;
        }
        let seat_bytes = payload.get(offset + 4..offset + 6)?;
        let seat = u16::from_le_bytes([seat_bytes[0], seat_bytes[1]]);
        offset += 6;
        let signer_len = read_u32(offset)? as usize;
        if signer_len != 32 {
            return None;
        }
        offset += 4;
        let session_signer_address = read_address(offset)?;
        if payload.len() != offset + 32 {
            return None;
        }
        return Some(DelegatedAccountKind::Session {
            owner,
            market,
            seat,
            session_signer: session_signer_address,
        });
    }
    // V3 account kinds all use `[tag, core/instrument, u8...]`. Re-encode
    // each accepted form so a merely similar Borsh list cannot be replayed
    // into the external callback with a different PDA meaning.
    let parse_v3 = |tag: &[u8], count: u32, trailing: usize| -> Option<(Address, [u8; 2])> {
        if read_u32(0)? != count {
            return None;
        }
        let mut offset = expect_vec(4, tag)?;
        if read_u32(offset)? != 32 {
            return None;
        }
        offset += 4;
        let parent = read_address(offset)?;
        offset += 32;
        let mut values = [0u8; 2];
        for value in values.iter_mut().take(trailing) {
            if read_u32(offset)? != 1 {
                return None;
            }
            offset += 4;
            *value = *payload.get(offset)?;
            offset += 1;
        }
        (offset == payload.len()).then_some((parent, values))
    };
    if payload.len() == V3_CORE_SEEDS_PAYLOAD_LEN {
        let (instrument, _) = parse_v3(v3::V3_MARKET_CORE_SEED, 2, 0)?;
        if encode_v3_core_delegate_seeds(&instrument).as_slice() == payload {
            return Some(DelegatedAccountKind::V3Core { instrument });
        }
    }
    if payload.len() == V3_BOOK_PAGE_SEEDS_PAYLOAD_LEN {
        let (core, bytes) = parse_v3(v3::V3_BOOK_PAGE_SEED, 4, 2)?;
        if bytes[0] <= 1
            && bytes[1] < v3::V3_BOOK_PAGES_PER_SIDE as u8
            && encode_v3_book_page_delegate_seeds(&core, bytes[0], bytes[1]).as_slice() == payload
        {
            return Some(DelegatedAccountKind::V3BookPage {
                core,
                side: bytes[0],
                page: bytes[1],
            });
        }
    }
    if payload.len() == V3_SEAT_SHARD_SEEDS_PAYLOAD_LEN {
        let (core, bytes) = parse_v3(v3::V3_SEAT_SHARD_SEED, 3, 1)?;
        if bytes[0] < v3::V3_SEAT_SHARDS as u8
            && encode_v3_seat_shard_delegate_seeds(&core, bytes[0]).as_slice() == payload
        {
            return Some(DelegatedAccountKind::V3SeatShard {
                core,
                shard: bytes[0],
            });
        }
    }
    if payload.len() == V3_EVENT_SHARD_SEEDS_PAYLOAD_LEN {
        let (core, bytes) = parse_v3(v3::V3_EVENT_SHARD_SEED, 3, 1)?;
        if bytes[0] < v3::V3_EVENT_SHARDS as u8
            && encode_v3_event_shard_delegate_seeds(&core, bytes[0]).as_slice() == payload
        {
            return Some(DelegatedAccountKind::V3EventShard {
                core,
                shard: bytes[0],
            });
        }
    }
    None
}

/// Maximum number of delegated accounts StockStream may include in a V3
/// commit intent: core + 18 book pages + 4 seat shards + 4 event shards.
/// The Magic Program ABI carries indices in a `Vec<u8>`; its scheduler applies
/// its own serialized-transaction size validation, not a 16-account limit.
/// Keeping this equal to the complete V3 execution bundle prevents a partial
/// commit helper from accidentally defining an unsafe custody boundary.
pub const MAX_COMMITTED_ACCOUNTS: usize = v3::V3_EXECUTION_BUNDLE_LEN;
/// `bincode::serialize(&MagicBlockInstruction::ScheduleIntentBundle(
///     MagicIntentBundleArgs { commit: Some(CommitTypeArgs::Standalone(indices)),
///     ..Default::default() }))` with the account order fixed as
/// `[payer, magic_context, committed_account_0, committed_account_1, ..]` --
/// the market is always index 2, trailing cluster accounts are 3.. `len()`
/// bytes are the used prefix; the rest of the buffer is zero. Golden vectors
/// verified against the real crate's own `bincode` serialization in
/// `tests/magicblock.rs` (including the historical market-only 29-byte shape).
/// Structure: variant(4) + Some(1) + Standalone(4) + len(8) + indices(n)
/// + None(1) + None(1) + None(1) + empty-vec-len(8) = 28 + n.
pub const SCHEDULE_COMMIT_DATA_MAX_LEN: usize = 28 + MAX_COMMITTED_ACCOUNTS;
/// Same bundle with `commit_and_undelegate: Some(CommitAndUndelegateArgs {
/// commit_type: Standalone(indices), undelegate_type: Standalone })`.
/// Structure: variant(4) + None(1) + Some(1) + Standalone(4) + len(8)
/// + indices(n) + UndelegateTypeArgs::Standalone(4) + None(1) + None(1)
/// + empty-vec-len(8) = 32 + n.
pub const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN: usize = 32 + MAX_COMMITTED_ACCOUNTS;
/// Shared fixed-capacity output buffer for both schedule encoders.
pub const SCHEDULE_DATA_MAX_LEN: usize = SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN;

/// Encodes `ScheduleIntentBundle` data committing the `committed_indices`
/// accounts (u8 indices into the instruction's `[payer, magic_context, ..]`
/// account list). `undelegate` selects the commit-only or
/// commit-and-undelegate intent. Returns the used prefix length.
pub fn encode_schedule_intent_bundle_data(
    indices: &[u8],
    undelegate: bool,
    out: &mut [u8; SCHEDULE_DATA_MAX_LEN],
) -> Result<usize, StockStreamError> {
    if indices.is_empty() || indices.len() > MAX_COMMITTED_ACCOUNTS {
        return Err(StockStreamError::MagicBlockInvalidAccount);
    }
    let len = if undelegate {
        SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN - MAX_COMMITTED_ACCOUNTS + indices.len()
    } else {
        SCHEDULE_COMMIT_DATA_MAX_LEN - MAX_COMMITTED_ACCOUNTS + indices.len()
    };
    out.fill(0);
    out[0..4].copy_from_slice(&11u32.to_le_bytes()); // ScheduleIntentBundle
    let mut offset = 4usize;
    if undelegate {
        out[offset] = 0; // commit: None
        offset += 1;
        out[offset] = 1; // commit_and_undelegate: Some
        offset += 1;
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes()); // Standalone
        offset += 4;
        out[offset..offset + 8].copy_from_slice(&(indices.len() as u64).to_le_bytes());
        offset += 8;
        out[offset..offset + indices.len()].copy_from_slice(indices);
        offset += indices.len();
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes()); // Standalone
        offset += 4;
    } else {
        out[offset] = 1; // commit: Some
        offset += 1;
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes()); // Standalone
        offset += 4;
        out[offset..offset + 8].copy_from_slice(&(indices.len() as u64).to_le_bytes());
        offset += 8;
        out[offset..offset + indices.len()].copy_from_slice(indices);
        offset += indices.len();
    }
    // Shared tail depends on how many Option fields remain:
    // - commit-only path has already serialized `commit: Some`, so three
    //   None-tagged Options follow (commit_and_undelegate, commit_finalize,
    //   commit_finalize_and_undelegate) plus the empty standalone_actions vec.
    // - commit-and-undelegate path has consumed both the None commit tag and
    //   the Some C&U payload, so two None tags follow, then the empty vec.
    // Both are empirically verified against the real crate's bincode output:
    // commit-only = 28+n bytes, C&U = 32+n bytes.
    if undelegate {
        offset += 2;
    } else {
        offset += 3;
    }
    out[offset..offset + 8].copy_from_slice(&0u64.to_le_bytes());
    offset += 8;
    if offset != len {
        return Err(StockStreamError::MagicBlockInvalidAccount);
    }
    Ok(len)
}

fn read_scratch_header(data: &[u8]) -> Result<SettlementScratchHeader, ProgramError> {
    if data.len() != SETTLEMENT_SCRATCH_LEN {
        return Err(custom(StockStreamError::InvalidSettlementScratch));
    }
    let mut value = MaybeUninit::<SettlementScratchHeader>::uninit();
    // SAFETY: length checked above; `SettlementScratchHeader` is `Copy` and
    // laid out as `repr(C, packed(1))`, so any byte pattern is valid.
    unsafe {
        core::ptr::copy_nonoverlapping(
            data.as_ptr(),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<SettlementScratchHeader>(),
        );
        Ok(value.assume_init())
    }
}

/// One validated member of the delegated hot cluster (the delegated market
/// itself plus every other program account a trading instruction writes
/// inside the same ER execution domain).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClusterMember {
    /// Settlement scratch PDA, `Empty` at the boundary.
    Scratch { market: Address, seat: u16 },
    /// `TradingSession` PDA.
    Session {
        owner: Address,
        market: Address,
        seat: u16,
        session_signer: Address,
    },
}

/// Validates that a single account is a legitimate member of the delegated
/// hot cluster for `market`:
/// - a settlement-scratch PDA (`["settlement", market, seat_le]`) that is
///   currently `Empty` -- no in-flight settlement plan may cross a delegation
///   boundary; or
/// - a `TradingSession` PDA for this market whose PDA re-derives from the
///   exact tuple stored inside the account.
///
/// Used by `delegate_market`, `commit_market` and `commit_and_undelegate_market`.
fn validate_cluster_member(
    program_id: &Address,
    market: &Address,
    account: &AccountView,
) -> Result<ClusterMember, ProgramError> {
    if !account.owned_by(program_id) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    match account.data_len() {
        SETTLEMENT_SCRATCH_LEN => {
            // SAFETY: read-only snapshot; length checked by `read_scratch_header`.
            let header = read_scratch_header(unsafe { account.borrow_unchecked() })?;
            if header.market != market.to_bytes()
                || *account.address()
                    != derive_settlement_scratch(market, header.trader_seat_index, program_id)
            {
                return Err(custom(StockStreamError::MagicBlockInvalidAccount));
            }
            if header.status != ScratchStatus::Empty as u8 {
                return Err(custom(StockStreamError::MagicBlockScratchNotEmpty));
            }
            Ok(ClusterMember::Scratch {
                market: *market,
                seat: header.trader_seat_index,
            })
        }
        session::TRADING_SESSION_SIZE => {
            // SAFETY: read-only snapshot; length checked above.
            let bytes = unsafe { account.borrow_unchecked() };
            let session = session::read_session(&bytes)?;
            if session.discriminator != session::TRADING_SESSION_DISCRIMINATOR
                || session.version != session::TRADING_SESSION_VERSION
                || session.target_program != program_id.to_bytes()
                || session.market != market.to_bytes()
            {
                return Err(custom(StockStreamError::MagicBlockInvalidAccount));
            }
            let expected = session::derive_trading_session(
                &Address::new_from_array(session.owner),
                market,
                session.trader_seat_index,
                &Address::new_from_array(session.session_signer),
                program_id,
            );
            if expected != *account.address() {
                return Err(custom(StockStreamError::MagicBlockInvalidAccount));
            }
            Ok(ClusterMember::Session {
                owner: Address::new_from_array(session.owner),
                market: *market,
                seat: session.trader_seat_index,
                session_signer: Address::new_from_array(session.session_signer),
            })
        }
        _ => Err(custom(StockStreamError::MagicBlockInvalidAccount)),
    }
}

fn no_duplicate_addresses(addresses: &[&Address]) -> bool {
    for i in 0..addresses.len() {
        for j in (i + 1)..addresses.len() {
            if addresses[i] == addresses[j] {
                return false;
            }
        }
    }
    true
}

// ---------------------------------------------------------------------
// DelegateMarket
// ---------------------------------------------------------------------

/// Accounts:
/// 0. `[WRITE]`          the market PDA being delegated
/// 1. `[SIGNER]`         market authority (must match `header.market_authority`)
/// 2. `[]`               the instrument PDA the market's seeds are derived from
/// 3. `[WRITE, SIGNER]`  fee payer (funds every buffer/record/metadata rent)
/// 4. `[WRITE]`          market delegate buffer PDA (`["buffer", market]`, StockStream-owned)
/// 5. `[WRITE]`          market delegation record PDA (`["delegation", market]`, delegation program)
/// 6. `[WRITE]`          market delegation metadata PDA (`["delegation-metadata", market]`, delegation program)
/// 7. `[]`               the delegation program (must equal `DELEGATION_PROGRAM_ID`)
/// 8. `[]`               the system program
/// 9. `[]`               StockStream's own executable program account (the CPI's `owner_program`)
/// 10.. settlement-scratch and/or `TradingSession` PDAs for this market.
///      These are NOT delegated by this instruction (each member is delegated
///      separately by `delegate_cluster_member`, batchable as post-instructions
///      in the same L1 transaction so the account list stays inside the base
///      layer's 1,232-byte transaction limit) -- they are validated here as a
///      delegation boundary gate: every member must be a valid hot-cluster
///      member, and scratch members must be `Empty` (no in-flight settlement
///      plan may cross a delegation boundary).
///
/// Local delegation state is only updated after the CPIs to the delegation
/// program succeed (a failed instruction rolls all writes back atomically).
pub fn delegate_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    validator: Address,
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if validator == Address::default() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !no_duplicate_addresses(&[
        accounts[0].address(),
        accounts[3].address(),
        accounts[4].address(),
        accounts[5].address(),
        accounts[6].address(),
    ]) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[3].is_signer() || !accounts[3].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[7].address() != DELEGATION_PROGRAM_ID
        || *accounts[8].address() != pinocchio_system::ID
        || *accounts[9].address() != *program_id
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    for account in [&accounts[0], &accounts[4], &accounts[5], &accounts[6]] {
        if !account.is_writable() {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
    }

    let authority = accounts[1].address().to_bytes();
    let instrument = *accounts[2].address();
    let market_key = *accounts[0].address();

    let (expected_market, market_bump) =
        Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id);
    if expected_market != market_key {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_buffer, _buffer_bump) =
        Address::find_program_address(&[DELEGATE_BUFFER_TAG, market_key.as_ref()], program_id);
    if expected_buffer != *accounts[4].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_record, _) = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_record != *accounts[5].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let (expected_metadata, _) = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market_key.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_metadata != *accounts[6].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    // Boundary gate: every trailing account must be a valid hot-cluster
    // member (scratch `Empty`, or a valid session PDA for this market).
    for account in &accounts[10..] {
        validate_cluster_member(program_id, &market_key, account)?;
    }

    // `AccountView` is a thin `Clone`-able handle onto the runtime's account
    // memory (see `solana-account-view`): cloning it does not copy account
    // data, it makes another handle to the same underlying account, so
    // mutating through any clone is visible through all of them. Using
    // independent clones here (instead of `split_at_mut` on `accounts`)
    // sidesteps a false aliasing conflict from the borrow checker, since the
    // account list mixes accounts this function must mutate (market, buffer)
    // with ones it only reads (payer, delegation record/metadata, ...).
    let mut market_view = accounts[0].clone();

    // Validate lifecycle state (authority, not already delegated) BEFORE
    // any buffer growth -- a rejected call must never even attempt a CPI,
    // and this read-only check is safe to repeat on every resumed call
    // (delegation_status only flips to `Delegated` on the final one, so a
    // legitimate in-progress resume always still reads `NotDelegated`/
    // `Restored` here).
    {
        let data = market_data(&mut market_view, program_id)?;
        let header = initialized_header(data)?;
        if header.market_authority != authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
        let status = header.delegation_status();
        if status != DelegationStatus::NotDelegated as u8
            && status != DelegationStatus::Restored as u8
        {
            return Err(custom(StockStreamError::MagicBlockAlreadyDelegated));
        }
    }

    // The market's buffer must be fully grown to the market's own size
    // BEFORE any of the header/event mutation below runs -- growth can take
    // multiple calls (see `ensure_buffer_ready`), and none of the
    // delegation-state changes below are safe to apply more than once. A
    // caller must keep invoking this instruction (same accounts) until it
    // returns having actually delegated; `market_view`'s delegation_status
    // only flips to `Delegated` on that final call.
    {
        let mut buffer_view = accounts[4].clone();
        let payer_view = accounts[3].clone();
        if !ensure_buffer_ready(&accounts[0], &mut buffer_view, &payer_view, program_id)? {
            return Ok(());
        }
    }

    // Stamp the new delegation state into the market's own bytes *before*
    // it is mirrored into the buffer: the delegation program's `Delegate`
    // instruction copies the buffer back into this account verbatim as its
    // last step, so this is how the updated state survives the CPI. If any
    // later step in this instruction fails, the whole instruction (and
    // every account write in it, including this one) is rolled back by the
    // runtime, so this still satisfies "only update local state after the
    // CPI succeeds".
    {
        let data = market_data(&mut market_view, program_id)?;
        let mut header = initialized_header(data)?;
        header.set_delegation_status(DelegationStatus::Delegated);
        header.set_validator(validator.to_bytes());
        header.set_delegation_sequence(header.delegation_sequence().saturating_add(1));
        header.set_commit_interval_ms(COMMIT_INTERVAL_MS);
        header.set_expected_commit_sequence(1);
        header.set_pending_undelegation(false);
        header.set_cluster_member_count((accounts.len() - 10) as u8);
        let requested_sequence = header
            .global_event_sequence
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        header.global_event_sequence = requested_sequence;
        let delegation_sequence = header.delegation_sequence();
        crate::events::emit_event(
            crate::events::EventKind::DelegationRequested,
            &market_key.to_bytes(),
            requested_sequence,
            event_timestamp(),
            &crate::events::payload_delegation(&validator.to_bytes(), delegation_sequence),
        );
        let sequence = header
            .global_event_sequence
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        header.global_event_sequence = sequence;
        write_header(data, &header)?;
        // The Delegation Program CPI below either succeeds (this whole
        // instruction, this write included, commits) or fails (the runtime
        // reverts every write in this instruction atomically) -- a failed
        // transaction's logs are still visible over RPC, which is exactly
        // why every indexer-side decoder in this program checks
        // `meta.err` and discards all events from a failed transaction
        // wholesale, rather than relying on emission order relative to
        // the CPI.
        crate::events::emit_event(
            crate::events::EventKind::MarketDelegated,
            &market_key.to_bytes(),
            sequence,
            event_timestamp(),
            &crate::events::payload_delegation(&validator.to_bytes(), delegation_sequence),
        );
    }

    // 1-5. Delegate the market itself, using the same per-account delegation
    //      sequence as every hot-cluster member (create buffer PDA, copy data
    //      into it, zero the account, reassign StockStream -> System ->
    //      Delegation Program, real `Delegate` CPI, drain buffer lamports).
    //      Cluster members are delegated separately by
    //      `delegate_cluster_member` (batchable post-instructions in the same
    //      L1 transaction), so this instruction's account list stays within
    //      the base layer's 1,232-byte transaction limit.
    let market_bump_slice = [market_bump];
    let market_seeds = [
        Seed::from(PERP_MARKET_SEED),
        Seed::from(instrument.as_ref()),
        Seed::from(&market_bump_slice),
    ];
    let market_signer = Signer::from(&market_seeds);

    delegate_single_account(
        &mut accounts[0].clone(),
        &accounts[4].clone(),
        &accounts[5].clone(),
        &accounts[6].clone(),
        &accounts[3].clone(),
        &accounts[8].clone(),
        &accounts[9].clone(),
        &market_signer,
        &encode_market_delegate_seeds(&instrument),
        &validator,
        program_id,
    )?;

    Ok(())
}

/// Opcode 48: delegates one bounded V3 PDA. The core is delegated first;
/// subsequent pages/shards must present that already-delegated core and the
/// identical validator. This is intentionally one account per instruction:
/// every account has its own delegation buffer/record/metadata PDA, and a
/// 22,592-byte page may require multiple resumable buffer-growth calls.
///
/// Accounts: `[parent, target(write), authority(signer), payer(write signer),
/// buffer(write), record(write), metadata(write), delegation_program, system,
/// owner_program]`. `parent` is the instrument for a core, otherwise the V3
/// core. The V2 perp market is never accepted by this path.
pub fn delegate_v3_account(
    program_id: &Address,
    accounts: &mut [AccountView],
    kind_raw: u8,
    index: u8,
    validator: Address,
) -> ProgramResult {
    if accounts.len() != 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if validator == Address::default() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !accounts[1].is_writable()
        || !accounts[2].is_signer()
        || !accounts[3].is_signer()
        || !accounts[3].is_writable()
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[7].address() != DELEGATION_PROGRAM_ID
        || *accounts[8].address() != pinocchio_system::ID
        || *accounts[9].address() != *program_id
        || !accounts[4].is_writable()
        || !accounts[5].is_writable()
        || !accounts[6].is_writable()
        || !no_duplicate_addresses(&[
            accounts[1].address(),
            accounts[3].address(),
            accounts[4].address(),
            accounts[5].address(),
            accounts[6].address(),
        ])
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let kind = v3::V3AccountKind::from_u8(kind_raw)
        .filter(|value| index <= value.max_index())
        .ok_or(ProgramError::InvalidInstructionData)?;
    let parent = *accounts[0].address();
    let expected = v3::derive_v3_account(program_id, &parent, kind, index)
        .ok_or(ProgramError::InvalidInstructionData)?;
    if expected != *accounts[1].address() || !accounts[1].owned_by(program_id) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let authority = accounts[2].address().to_bytes();
    match kind {
        v3::V3AccountKind::MarketCore => {
            validate_v3_delegate_core(program_id, &accounts[0], &accounts[1], &authority, None)?;
        }
        _ => {
            // The core is intentionally read-only here: once delegated it is
            // owned by the delegation program on L1, but its committed bytes
            // remain the authority/validator binding for every child shard.
            validate_v3_delegate_core(
                program_id,
                &accounts[0],
                &accounts[1],
                &authority,
                Some(&validator),
            )?;
            validate_restored_v3_account(
                unsafe { accounts[1].borrow_unchecked() },
                kind,
                &parent,
                index,
            )?;
        }
    }
    let (expected_buffer, _) = Address::find_program_address(
        &[DELEGATE_BUFFER_TAG, accounts[1].address().as_ref()],
        program_id,
    );
    let (expected_record, _) = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, accounts[1].address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    let (expected_metadata, _) = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, accounts[1].address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_buffer != *accounts[4].address()
        || expected_record != *accounts[5].address()
        || expected_metadata != *accounts[6].address()
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    // The core records the validator before it is copied to its delegation
    // buffer. A child cannot be handed to a different ER validator later.
    if kind == v3::V3AccountKind::MarketCore {
        let bytes = unsafe { accounts[1].borrow_unchecked_mut() };
        bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET] = DelegationStatus::Delegated as u8;
        bytes[v3::V3_CORE_VALIDATOR_OFFSET..v3::V3_CORE_VALIDATOR_OFFSET + 32]
            .copy_from_slice(validator.as_ref());
        bytes[v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET
            ..v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET + 8]
            .copy_from_slice(&1u64.to_le_bytes());
    }

    let delegated = match kind {
        v3::V3AccountKind::MarketCore => {
            let (_, bump) = Address::find_program_address(
                &[v3::V3_MARKET_CORE_SEED, parent.as_ref()],
                program_id,
            );
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_MARKET_CORE_SEED),
                Seed::from(parent.as_ref()),
                Seed::from(&bump_slice),
            ];
            delegate_single_account(
                &mut accounts[1].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[3].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &Signer::from(&seeds),
                &encode_v3_core_delegate_seeds(&parent),
                &validator,
                program_id,
            )?
        }
        v3::V3AccountKind::BookPage => {
            let side = index / v3::V3_BOOK_PAGES_PER_SIDE as u8;
            let page = index % v3::V3_BOOK_PAGES_PER_SIDE as u8;
            let (_, bump) = Address::find_program_address(
                &[v3::V3_BOOK_PAGE_SEED, parent.as_ref(), &[side], &[page]],
                program_id,
            );
            let side_slice = [side];
            let page_slice = [page];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_BOOK_PAGE_SEED),
                Seed::from(parent.as_ref()),
                Seed::from(&side_slice),
                Seed::from(&page_slice),
                Seed::from(&bump_slice),
            ];
            delegate_single_account(
                &mut accounts[1].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[3].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &Signer::from(&seeds),
                &encode_v3_book_page_delegate_seeds(&parent, side, page),
                &validator,
                program_id,
            )?
        }
        v3::V3AccountKind::SeatShard => {
            let (_, bump) = Address::find_program_address(
                &[v3::V3_SEAT_SHARD_SEED, parent.as_ref(), &[index]],
                program_id,
            );
            let index_slice = [index];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_SEAT_SHARD_SEED),
                Seed::from(parent.as_ref()),
                Seed::from(&index_slice),
                Seed::from(&bump_slice),
            ];
            delegate_single_account(
                &mut accounts[1].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[3].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &Signer::from(&seeds),
                &encode_v3_seat_shard_delegate_seeds(&parent, index),
                &validator,
                program_id,
            )?
        }
        v3::V3AccountKind::EventShard => {
            let (_, bump) = Address::find_program_address(
                &[v3::V3_EVENT_SHARD_SEED, parent.as_ref(), &[index]],
                program_id,
            );
            let index_slice = [index];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_EVENT_SHARD_SEED),
                Seed::from(parent.as_ref()),
                Seed::from(&index_slice),
                Seed::from(&bump_slice),
            ];
            delegate_single_account(
                &mut accounts[1].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[3].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &Signer::from(&seeds),
                &encode_v3_event_shard_delegate_seeds(&parent, index),
                &validator,
                program_id,
            )?
        }
    };
    // For page buffers this false result means callers repeat opcode 48;
    // only the fully successful call reaches the real Delegate CPI.
    if !delegated && kind == v3::V3AccountKind::MarketCore {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    Ok(())
}

fn validate_v3_delegate_core(
    program_id: &Address,
    parent: &AccountView,
    target: &AccountView,
    authority: &[u8; 32],
    expected_validator: Option<&Address>,
) -> ProgramResult {
    let core = if expected_validator.is_none() {
        target
    } else {
        parent
    };
    let bytes = unsafe { core.borrow_unchecked() };
    if bytes.len() != v3::V3_MARKET_CORE_SIZE
        || bytes[0..8] != v3::V3_MARKET_CORE_DISCRIMINATOR
        || bytes[8..10] != v3::V3_LAYOUT_VERSION.to_le_bytes()
        || bytes[10] != 1
        || bytes[v3::V3_CORE_MODE_OFFSET] != 1
        || bytes[v3::V3_CORE_MARKET_AUTHORITY_OFFSET..v3::V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != *authority
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if let Some(validator) = expected_validator {
        if bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::Delegated as u8
            || bytes[v3::V3_CORE_VALIDATOR_OFFSET..v3::V3_CORE_VALIDATOR_OFFSET + 32]
                != *validator.as_ref()
        {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
    } else {
        // For a core, the parent is the active instrument and target embeds
        // that exact instrument address.
        let instrument = unsafe { parent.borrow_unchecked() };
        if !parent.owned_by(program_id)
            || instrument.len() != INSTRUMENT_SIZE
            || instrument[0..8] != INSTRUMENT_DISCRIMINATOR
            || instrument[10] != 1
            || instrument[111] != 0
            || bytes[v3::V3_CORE_INSTRUMENT_OFFSET..v3::V3_CORE_INSTRUMENT_OFFSET + 32]
                != parent.address().to_bytes()
            || bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::NotDelegated as u8
        {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
    }
    Ok(())
}

/// Creates (if needed) and grows `buffer` until its data length matches
/// `account`'s -- returns `true` once ready. A single instruction can only
/// increase an account's data length by `MAX_PERMITTED_DATA_INCREASE`
/// (10,240) bytes, whether via a fresh `CreateAccount` CPI or a direct
/// owner-side realloc, so an account this large (the market itself, up to
/// `state::MARKET_ACCOUNT_SIZE` bytes) cannot be buffered in one call: the
/// caller must invoke this (and therefore `delegate_market`) repeatedly,
/// once per top-level instruction, until it returns `true` -- exactly the
/// same constraint and technique `registry::create_market_account` already
/// uses for the market's own incremental growth. Cluster members (the
/// largest being `SETTLEMENT_SCRATCH_LEN` bytes) are always well under the
/// cap, so this always completes for them in one call.
fn ensure_buffer_ready(
    account: &AccountView,
    buffer: &mut AccountView,
    payer: &AccountView,
    program_id: &Address,
) -> Result<bool, ProgramError> {
    const MAX_PERMITTED_DATA_INCREASE: usize = 10_240;
    let target_len = account.data_len();

    if !buffer.owned_by(program_id) {
        if buffer.data_len() != 0 {
            // A foreign, non-empty account already sits at this PDA.
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
        let (_, buffer_bump) = Address::find_program_address(
            &[DELEGATE_BUFFER_TAG, account.address().as_ref()],
            program_id,
        );
        let buffer_bump_slice = [buffer_bump];
        let buffer_signer_seeds: [Seed; 3] = [
            Seed::from(DELEGATE_BUFFER_TAG),
            Seed::from(account.address().as_ref()),
            Seed::from(&buffer_bump_slice),
        ];
        let buffer_signer = Signer::from(&buffer_signer_seeds);
        let rent = Rent::get()?;
        CreateAccount {
            from: payer,
            to: buffer,
            lamports: rent.try_minimum_balance(target_len)?,
            space: target_len.min(MAX_PERMITTED_DATA_INCREASE) as u64,
            owner: program_id,
        }
        .invoke_signed(core::slice::from_ref(&buffer_signer))?;
    } else if buffer.data_len() < target_len {
        let next = (buffer.data_len() + MAX_PERMITTED_DATA_INCREASE).min(target_len);
        unsafe {
            let raw = buffer.account_mut_ptr();
            core::ptr::write_unaligned(&mut (*raw).data_len as *mut u64, next as u64);
        }
    }

    Ok(buffer.data_len() >= target_len)
}

/// The delegation sequence shared by `delegate_market` and
/// `delegate_cluster_member`, per `dlp_api::processor::fast::delegate.rs`:
/// 1. Create the buffer PDA (`["buffer", account]`, StockStream-owned) sized
///    to hold a full copy of the account while ownership is in flight.
/// 2. Copy the account's data into the buffer, then zero the account's data
///    -- the runtime only allows a direct owner change on zeroed data.
/// 3. Reassign the account: StockStream -> System Program (direct, zeroed
///    data) -> Delegation Program (real system::assign CPI signed by the
///    account's own PDA seeds).
/// 4. The real `Delegate` CPI (discriminator 0, `DelegateArgs` with the
///    account's own borsh seeds payload). Only after this returns `Ok` is
///    the account delegated.
/// 5. The buffer is still StockStream-owned (the delegation program never
///    reassigns it); drain its lamports back to the payer directly.
#[allow(clippy::too_many_arguments)]
fn delegate_single_account(
    account: &mut AccountView,
    buffer: &AccountView,
    record: &AccountView,
    metadata: &AccountView,
    payer: &AccountView,
    system_program: &AccountView,
    owner_program: &AccountView,
    account_signer: &Signer,
    seeds_payload: &[u8],
    validator: &Address,
    program_id: &Address,
) -> Result<bool, ProgramError> {
    // 1. Create and/or grow the buffer PDA. Always completes in one call
    // for cluster members (well under the per-instruction growth cap);
    // `delegate_market` already confirmed this for the market itself
    // before ever reaching this call, so this is a cheap, idempotent
    // re-check for it, not redundant work.
    let mut buffer_view = buffer.clone();
    let mut payer_view = payer.clone();
    if !ensure_buffer_ready(account, &mut buffer_view, &payer_view, program_id)? {
        return Ok(false);
    }

    // 2. Copy the account's data into the buffer, then zero the account's
    //    data.
    {
        let account_bytes = unsafe { account.borrow_unchecked() };
        let mut buffer_bytes = buffer_view.try_borrow_mut()?;
        buffer_bytes.copy_from_slice(account_bytes);
    }
    unsafe { account.borrow_unchecked_mut() }.fill(0);

    // 3. Reassign: StockStream -> System Program (direct, zeroed data), then
    //    System Program -> Delegation Program (real CPI, signed by the
    //    account's own seeds).
    unsafe { account.assign(&pinocchio_system::ID) };
    {
        let assign_accounts = [InstructionAccount::writable_signer(account.address())];
        let mut assign_data = [0u8; 36];
        assign_data[0] = 1;
        assign_data[4..36].copy_from_slice(DELEGATION_PROGRAM_ID.as_ref());
        let assign_ix = InstructionView {
            program_id: &pinocchio_system::ID,
            accounts: &assign_accounts,
            data: &assign_data,
        };
        invoke_signed(
            &assign_ix,
            &[&*account],
            core::slice::from_ref(account_signer),
        )?;
    }

    // 4. The real Delegation Program `Delegate` CPI.
    let mut delegate_data = [0u8; DELEGATE_INSTRUCTION_DATA_MAX_LEN];
    let delegate_len =
        encode_delegate_instruction_data_from_seeds(seeds_payload, validator, &mut delegate_data)?;
    let delegate_accounts = [
        InstructionAccount::writable_signer(payer_view.address()),
        InstructionAccount::writable_signer(account.address()),
        InstructionAccount::readonly(owner_program.address()),
        InstructionAccount::writable(buffer_view.address()),
        InstructionAccount::writable(record.address()),
        InstructionAccount::writable(metadata.address()),
        InstructionAccount::readonly(system_program.address()),
    ];
    let delegate_ix = InstructionView {
        program_id: &DELEGATION_PROGRAM_ID,
        accounts: &delegate_accounts,
        data: &delegate_data[..delegate_len],
    };
    invoke_signed(
        &delegate_ix,
        &[
            &payer_view,
            account,
            &*owner_program,
            &buffer_view,
            &*record,
            &*metadata,
            &*system_program,
        ],
        core::slice::from_ref(account_signer),
    )?;

    // 5. Drain the buffer's lamports back to the payer.
    let refund = buffer_view.lamports();
    if refund > 0 {
        buffer_view.set_lamports(0);
        let payer_lamports = payer_view.lamports();
        payer_view.set_lamports(payer_lamports.saturating_add(refund));
    }

    Ok(true)
}

/// `DelegateArgs` instruction data from a pre-encoded borsh seeds payload:
/// `u64 discriminator(0) || commit_frequency_ms(4) || seeds || Some-tag(1) ||
/// validator(32)`. Returns the used prefix length.
pub fn encode_delegate_instruction_data_from_seeds(
    seeds_payload: &[u8],
    validator: &Address,
    out: &mut [u8; DELEGATE_INSTRUCTION_DATA_MAX_LEN],
) -> Result<usize, StockStreamError> {
    if seeds_payload.len() > MAX_SEEDS_PAYLOAD_LEN {
        return Err(StockStreamError::MagicBlockInvalidAccount);
    }
    out.fill(0);
    out[0..8].copy_from_slice(&DELEGATE_DISCRIMINATOR.to_le_bytes());
    out[8..12].copy_from_slice(&COMMIT_INTERVAL_MS.to_le_bytes());
    out[12..12 + seeds_payload.len()].copy_from_slice(seeds_payload);
    let mut offset = 12 + seeds_payload.len();
    out[offset] = 1; // Option::Some
    offset += 1;
    out[offset..offset + 32].copy_from_slice(validator.as_ref());
    Ok(offset + 32)
}

// ---------------------------------------------------------------------
// DelegateClusterMember (opcode 41)
// ---------------------------------------------------------------------

/// Delegates ONE hot-cluster member (a settlement-scratch PDA or a
/// `TradingSession` PDA) to the same validator as its already-delegated
/// market. Invoked on L1, batchable as post-instructions of the same
/// `DelegateMarket` transaction (or later for newly authorized sessions --
/// an L1 transaction writing only a not-yet-delegated session PDA is a valid
/// single-domain L1 transaction).
///
/// Accounts:
/// 0. `[]`               the delegated market PDA (READ-ONLY: it belongs to
///                       the delegation program now and L1 must not write it;
///                       it is validated to bound the member to this market)
/// 1. `[SIGNER]`         market authority (must match `header.market_authority`)
/// 2. `[WRITE]`          the member account (scratch: `Empty`; or session)
/// 3. `[WRITE]`          member buffer PDA (`["buffer", member]`, StockStream-owned)
/// 4. `[WRITE]`          member delegation record PDA (`["delegation", member]`)
/// 5. `[WRITE]`          member delegation metadata PDA (`["delegation-metadata", member]`)
/// 6. `[WRITE, SIGNER]`  fee payer
/// 7. `[]`               the delegation program
/// 8. `[]`               the system program
/// 9. `[]`               StockStream's own executable program account
///
/// Data: `[tag(1), validator(32)]`.
pub fn delegate_cluster_member(
    program_id: &Address,
    accounts: &mut [AccountView],
    validator: Address,
) -> ProgramResult {
    if accounts.len() != 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if validator == Address::default() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if *accounts[7].address() != DELEGATION_PROGRAM_ID
        || *accounts[8].address() != pinocchio_system::ID
        || *accounts[9].address() != *program_id
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[6].is_signer() || !accounts[6].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !no_duplicate_addresses(&[
        accounts[0].address(),
        accounts[2].address(),
        accounts[3].address(),
        accounts[4].address(),
        accounts[5].address(),
        accounts[6].address(),
    ]) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    for account in [&accounts[2], &accounts[3], &accounts[4], &accounts[5]] {
        if !account.is_writable() {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
    }
    if accounts[0].is_writable() {
        // A delegated account must never be written on L1; keeping it
        // read-only here makes the whole transaction a valid single-domain L1
        // transaction even while the market is delegated.
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let market_key = *accounts[0].address();
    {
        // The market must already be delegated, and to this exact validator.
        // Read-only: a delegated market must never be written on L1, so this
        // is a plain data borrow, not `market_data` (which enforces
        // writability for handlers that mutate it).
        let market_view = accounts[0].clone();
        let bytes = unsafe { market_view.borrow_unchecked() };
        let header = initialized_header(&bytes)?;
        if header.delegation_status() != DelegationStatus::Delegated as u8 {
            return Err(custom(StockStreamError::MagicBlockNotDelegated));
        }
        if header.validator() != validator.to_bytes() {
            return Err(custom(StockStreamError::MagicBlockInvalidAccount));
        }
        if accounts[1].address().to_bytes() != header.market_authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    let member = validate_cluster_member(program_id, &market_key, &accounts[2])?;

    // The member's own PDA seeds (plus bump) are the CPI signer and the
    // seeds payload the delegation program replays back at undelegation.
    match member {
        ClusterMember::Scratch { market, seat } => {
            let seat_le = seat.to_le_bytes();
            let (_, bump) = Address::find_program_address(
                &[scratch::SETTLEMENT_SEED, market.as_ref(), &seat_le],
                program_id,
            );
            let bump_slice = [bump];
            let signer_seed_array = [
                Seed::from(scratch::SETTLEMENT_SEED),
                Seed::from(market.as_ref()),
                Seed::from(&seat_le),
                Seed::from(&bump_slice),
            ];
            let signer = Signer::from(&signer_seed_array);
            let seeds_payload = encode_scratch_delegate_seeds(&market, seat);
            delegate_single_account(
                &mut accounts[2].clone(),
                &accounts[3].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &signer,
                &seeds_payload,
                &validator,
                program_id,
            )
            // Cluster members (scratch/session) are always well under the
            // per-instruction growth cap, so this always completes in one
            // call -- the bool is never meaningfully `false` here.
            .map(|_ready| ())
        }
        ClusterMember::Session {
            owner,
            market,
            seat,
            session_signer,
        } => {
            let seat_le = seat.to_le_bytes();
            let (_, bump) = Address::find_program_address(
                &[
                    session::TRADING_SESSION_SEED,
                    owner.as_ref(),
                    market.as_ref(),
                    &seat_le,
                    session_signer.as_ref(),
                ],
                program_id,
            );
            let bump_slice = [bump];
            let signer_seed_array = [
                Seed::from(session::TRADING_SESSION_SEED),
                Seed::from(owner.as_ref()),
                Seed::from(market.as_ref()),
                Seed::from(&seat_le),
                Seed::from(session_signer.as_ref()),
                Seed::from(&bump_slice),
            ];
            let signer = Signer::from(&signer_seed_array);
            let seeds_payload =
                encode_session_delegate_seeds(&owner, &market, seat, &session_signer);
            delegate_single_account(
                &mut accounts[2].clone(),
                &accounts[3].clone(),
                &accounts[4].clone(),
                &accounts[5].clone(),
                &accounts[6].clone(),
                &accounts[8].clone(),
                &accounts[9].clone(),
                &signer,
                &seeds_payload,
                &validator,
                program_id,
            )
            .map(|_ready| ())
        }
    }
}

// ---------------------------------------------------------------------
// CommitMarket / CommitAndUndelegate
// ---------------------------------------------------------------------

enum CommitKind {
    CommitOnly,
    CommitAndUndelegate,
}

/// Accounts (both `CommitMarket` and `CommitAndUndelegate`):
/// 0. `[WRITE]`         the delegated market PDA
/// 1. `[SIGNER]`        authorized keeper/authority (must match `header.market_authority`)
/// 2. `[WRITE, SIGNER]` fee payer for the Magic Program CPI
/// 3. `[WRITE]`         Magic Context account (must equal `MAGIC_CONTEXT_ID`)
/// 4. `[]`              the Magic Program (must equal `MAGIC_PROGRAM_ID`)
/// 5.. committed hot-cluster members (settlement-scratch PDAs, `Empty`, and
///     /or `TradingSession` PDAs) -- every one is included in the same commit
///      intent, so the market and its cluster land on L1 atomically.
fn commit_market_inner(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
    kind: CommitKind,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[2].is_signer() || !accounts[2].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != MAGIC_CONTEXT_ID || !accounts[3].is_writable() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if *accounts[4].address() != MAGIC_PROGRAM_ID {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if sequence == 0 {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }
    if !no_duplicate_addresses(&[
        accounts[0].address(),
        accounts[2].address(),
        accounts[3].address(),
    ]) {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let authority = accounts[1].address().to_bytes();
    let market_key = *accounts[0].address();
    if accounts.len() - 5 > MAX_COMMITTED_ACCOUNTS - 1 {
        return Err(custom(StockStreamError::MagicBlockClusterTooLarge));
    }
    for account in &accounts[5..] {
        validate_cluster_member(program_id, &market_key, account)?;
    }

    {
        let data = market_data(&mut accounts[0], program_id)?;
        let header = initialized_header(data)?;
        if header.market_authority != authority {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if header.delegation_status() != DelegationStatus::Delegated as u8 {
            return Err(custom(StockStreamError::MagicBlockNotDelegated));
        }
        if matches!(kind, CommitKind::CommitAndUndelegate) && header.pending_undelegation() {
            return Err(custom(StockStreamError::MagicBlockUndelegationInProgress));
        }
        if sequence != header.expected_commit_sequence() {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
    }

    // Intent accounts: `[payer, magic_context, committed_0, committed_1, ..]`
    // -- the market is always committed index 2, trailing members 3...
    let committed_count = 1 + (accounts.len() - 5);
    let mut indices = [0u8; MAX_COMMITTED_ACCOUNTS];
    for (i, index) in indices.iter_mut().enumerate().take(committed_count) {
        *index = (2 + i) as u8;
    }
    let mut commit_data_buf = [0u8; SCHEDULE_DATA_MAX_LEN];
    let commit_len = encode_schedule_intent_bundle_data(
        &indices[..committed_count],
        matches!(kind, CommitKind::CommitAndUndelegate),
        &mut commit_data_buf,
    )
    .map_err(custom)?;
    // Output slot `i` (i >= 3) is trailing committed member `i - 3`, which
    // lives at `accounts[5 + (i - 3)] = accounts[2 + i]` -- `accounts[0..5]`
    // are the fixed market/authority/payer/magic_context/magic_program
    // quintet, so the first real member starts at `accounts[5]`, not
    // `accounts[3]`. `commit_views` below already gets this right (its own
    // `accounts[5..]` iteration); this metadata array previously read
    // `accounts.get(3 + i)`, which is off by two slots and either points at
    // the WRONG member (shifted by two) or silently falls back to
    // `accounts[0]` (the market, duplicated) once past the real bounds --
    // producing a CPI instruction whose declared pubkeys didn't match the
    // account views actually passed to it, which the Magic Program
    // correctly rejects. Found only by actually committing a real
    // delegated cluster with a trailing member on live Devnet; no existing
    // test invoked the real (builtin, not a regular deployed program)
    // Magic Program to catch it.
    let commit_accounts: [InstructionAccount; MAX_COMMITTED_ACCOUNTS + 2] =
        core::array::from_fn(|i| match i {
            0 => InstructionAccount::writable_signer(accounts[2].address()),
            1 => InstructionAccount::writable(accounts[3].address()),
            2 => InstructionAccount::writable(accounts[0].address()),
            _ => {
                let member = accounts.get(2 + i).unwrap_or(&accounts[0]);
                InstructionAccount::writable(member.address())
            }
        });
    let commit_ix = InstructionView {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &commit_accounts[..committed_count + 2],
        data: &commit_data_buf[..commit_len],
    };
    let mut commit_views: [&AccountView; MAX_COMMITTED_ACCOUNTS + 2] =
        [&accounts[0]; MAX_COMMITTED_ACCOUNTS + 2];
    commit_views[0] = &accounts[2];
    commit_views[1] = &accounts[3];
    commit_views[2] = &accounts[0];
    for (i, account) in accounts[5..].iter().enumerate() {
        commit_views[3 + i] = account;
    }
    invoke_signed_with_bounds::<{ MAX_COMMITTED_ACCOUNTS + 2 }, _>(
        &commit_ix,
        &commit_views[..committed_count + 2],
        &[],
    )?;

    // Only reachable once the CPI above returned `Ok`.
    let data = market_data(&mut accounts[0], program_id)?;
    let mut header = initialized_header(data)?;
    header.set_last_committed_sequence(sequence);
    let event_kind = match kind {
        CommitKind::CommitOnly => {
            header.set_expected_commit_sequence(sequence.saturating_add(1));
            crate::events::EventKind::CommitRequested
        }
        CommitKind::CommitAndUndelegate => {
            header.set_delegation_status(DelegationStatus::Undelegating);
            header.set_pending_undelegation(true);
            header.set_expected_final_commit_sequence(sequence);
            crate::events::EventKind::UndelegationRequested
        }
    };
    let event_sequence = header
        .global_event_sequence
        .checked_add(1)
        .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
    header.global_event_sequence = event_sequence;
    let expected_commit_sequence = header.expected_commit_sequence();
    write_header(data, &header)?;
    crate::events::emit_event(
        event_kind,
        &market_key.to_bytes(),
        event_sequence,
        event_timestamp(),
        &crate::events::payload_delegation(&header.validator(), sequence),
    );
    if matches!(kind, CommitKind::CommitOnly) {
        let data = market_data(&mut accounts[0], program_id)?;
        let mut header = initialized_header(data)?;
        let sequence_changed_event = header
            .global_event_sequence
            .checked_add(1)
            .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
        header.global_event_sequence = sequence_changed_event;
        write_header(data, &header)?;
        crate::events::emit_event(
            crate::events::EventKind::CommitSequenceChanged,
            &market_key.to_bytes(),
            sequence_changed_event,
            event_timestamp(),
            &crate::events::payload_delegation(&header.validator(), expected_commit_sequence),
        );
    }
    Ok(())
}

pub fn commit_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    if is_v3_commit_accounts(accounts) {
        return commit_v3_bundle(program_id, accounts, sequence, CommitKind::CommitOnly);
    }
    if is_v3_member_commit_accounts(accounts) {
        return commit_v3_member(program_id, accounts, sequence, CommitKind::CommitOnly);
    }
    if is_v3_core_commit_accounts(accounts) {
        return commit_v3_core(program_id, accounts, sequence, CommitKind::CommitOnly);
    }
    commit_market_inner(program_id, accounts, sequence, CommitKind::CommitOnly)
}

pub fn commit_and_undelegate_market(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
) -> ProgramResult {
    if is_v3_commit_accounts(accounts) {
        return commit_v3_bundle(
            program_id,
            accounts,
            sequence,
            CommitKind::CommitAndUndelegate,
        );
    }
    if is_v3_member_commit_accounts(accounts) {
        return commit_v3_member(
            program_id,
            accounts,
            sequence,
            CommitKind::CommitAndUndelegate,
        );
    }
    if is_v3_core_commit_accounts(accounts) {
        return commit_v3_core(
            program_id,
            accounts,
            sequence,
            CommitKind::CommitAndUndelegate,
        );
    }
    commit_market_inner(
        program_id,
        accounts,
        sequence,
        CommitKind::CommitAndUndelegate,
    )
}

fn is_v3_commit_accounts(accounts: &[AccountView]) -> bool {
    accounts.len() >= 5 + v3::V3_EXECUTION_BUNDLE_LEN - 1
        && accounts[0].data_len() == v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8] == v3::V3_MARKET_CORE_DISCRIMINATOR
}

fn is_v3_core_commit_accounts(accounts: &[AccountView]) -> bool {
    accounts.len() == 5
        && accounts[0].data_len() == v3::V3_MARKET_CORE_SIZE
        && unsafe { accounts[0].borrow_unchecked() }[0..8] == v3::V3_MARKET_CORE_DISCRIMINATOR
}

fn is_v3_member_commit_accounts(accounts: &[AccountView]) -> bool {
    if accounts.len() != 6 || accounts[5].data_len() != v3::V3_MARKET_CORE_SIZE {
        return false;
    }
    let bytes = unsafe { accounts[0].borrow_unchecked() };
    bytes.len() >= 12
        && (bytes[0..8] == v3::V3_BOOK_PAGE_DISCRIMINATOR
            || bytes[0..8] == v3::V3_SEAT_SHARD_DISCRIMINATOR
            || bytes[0..8] == v3::V3_EVENT_SHARD_DISCRIMINATOR)
}

/// Magic Program commit path for the complete V3 execution bundle.  The
/// first five accounts retain the established commit ABI (`core, authority,
/// payer, context, magic program`); the remaining 26 accounts are the V3
/// pages/shards in canonical bundle order.  The CPI therefore commits all 27
/// bounded accounts atomically without ever passing the V2 monolith.
fn commit_v3_bundle(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
    kind: CommitKind,
) -> ProgramResult {
    let expected_len = 5 + v3::V3_EXECUTION_BUNDLE_LEN - 1;
    if accounts.len() != expected_len {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if !accounts[1].is_signer() || !accounts[2].is_signer() || !accounts[2].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != MAGIC_CONTEXT_ID
        || !accounts[3].is_writable()
        || *accounts[4].address() != MAGIC_PROGRAM_ID
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if sequence == 0 || accounts[0].address() == accounts[2].address() {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }
    let mut bundle: [AccountView; v3::V3_EXECUTION_BUNDLE_LEN] = core::array::from_fn(|index| {
        if index == 0 {
            accounts[0].clone()
        } else {
            accounts[4 + index].clone()
        }
    });
    v3::validate_execution_bundle(program_id, &bundle, true)
        .map_err(|_| custom(StockStreamError::MagicBlockInvalidAccount))?;
    let authority = accounts[1].address().to_bytes();
    {
        let core = unsafe { bundle[0].borrow_unchecked() };
        if core[v3::V3_CORE_MARKET_AUTHORITY_OFFSET..v3::V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != authority
            || core[v3::V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::Delegated as u8
            || core_u64(&core, v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET)? != sequence
        {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
    }
    let mut indices = [0u8; v3::V3_EXECUTION_BUNDLE_LEN];
    for (offset, index) in indices.iter_mut().enumerate() {
        *index = (2 + offset) as u8;
    }
    let mut data_buf = [0u8; SCHEDULE_DATA_MAX_LEN];
    let data_len = encode_schedule_intent_bundle_data(
        &indices,
        matches!(kind, CommitKind::CommitAndUndelegate),
        &mut data_buf,
    )
    .map_err(custom)?;
    let commit_accounts: [InstructionAccount; MAX_COMMITTED_ACCOUNTS + 2] =
        core::array::from_fn(|index| match index {
            0 => InstructionAccount::writable_signer(accounts[2].address()),
            1 => InstructionAccount::writable(accounts[3].address()),
            _ => InstructionAccount::writable(bundle[index - 2].address()),
        });
    let commit_ix = InstructionView {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &commit_accounts[..v3::V3_EXECUTION_BUNDLE_LEN + 2],
        data: &data_buf[..data_len],
    };
    let mut views: [&AccountView; MAX_COMMITTED_ACCOUNTS + 2] =
        [&accounts[0]; MAX_COMMITTED_ACCOUNTS + 2];
    views[0] = &accounts[2];
    views[1] = &accounts[3];
    for (index, account) in bundle.iter().enumerate() {
        views[index + 2] = account;
    }
    invoke_signed_with_bounds::<{ MAX_COMMITTED_ACCOUNTS + 2 }, _>(
        &commit_ix,
        &views[..v3::V3_EXECUTION_BUNDLE_LEN + 2],
        &[],
    )?;
    {
        let core = unsafe { bundle[0].borrow_unchecked_mut() };
        core[v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET
            ..v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET + 8]
            .copy_from_slice(&sequence.to_le_bytes());
        if matches!(kind, CommitKind::CommitOnly) {
            core[v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET
                ..v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET + 8]
                .copy_from_slice(&sequence.saturating_add(1).to_le_bytes());
        } else {
            core[v3::V3_CORE_DELEGATION_STATUS_OFFSET] = DelegationStatus::Undelegating as u8;
        }
    }
    let mut validator = [0u8; 32];
    validator.copy_from_slice(
        &unsafe { bundle[0].borrow_unchecked() }
            [v3::V3_CORE_VALIDATOR_OFFSET..v3::V3_CORE_VALIDATOR_OFFSET + 32],
    );
    let payload = crate::events::payload_delegation(&validator, sequence);
    let (core_bundle, rest_bundle) = bundle.split_at_mut(1);
    let (_, event_bundle) =
        rest_bundle.split_at_mut((2 * v3::V3_BOOK_PAGES_PER_SIDE) + v3::V3_SEAT_SHARDS);
    v3::append_event_record(
        program_id,
        &mut core_bundle[0],
        &mut event_bundle[..v3::V3_EVENT_SHARDS],
        if matches!(kind, CommitKind::CommitOnly) {
            crate::events::EventKind::CommitRequested as u16
        } else {
            crate::events::EventKind::UndelegationRequested as u16
        },
        &payload,
        event_timestamp(),
    )
}

/// Commit one V3 child shard without putting the complete 27-account bundle
/// into a single scheduled intent. MagicBlock's deployed validator can reject
/// a large intent even when every account is individually committable. The
/// core is supplied as a validation/bookkeeping account but is intentionally
/// omitted from the Magic CPI; this keeps the scheduled intent to one child.
/// Callers commit all children, then use the five-account core form below.
fn commit_v3_member(
    program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
    kind: CommitKind,
) -> ProgramResult {
    if accounts.len() != 6
        || !accounts[1].is_signer()
        || !accounts[2].is_signer()
        || !accounts[2].is_writable()
        || !accounts[0].is_writable()
        || !accounts[5].is_writable()
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != MAGIC_CONTEXT_ID
        || !accounts[3].is_writable()
        || *accounts[4].address() != MAGIC_PROGRAM_ID
        || accounts[0].address() == accounts[5].address()
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if sequence == 0 {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }

    let core_bytes = unsafe { accounts[5].borrow_unchecked() };
    if core_bytes.len() != v3::V3_MARKET_CORE_SIZE
        || core_bytes[0..8] != v3::V3_MARKET_CORE_DISCRIMINATOR
        || core_bytes[8..10] != v3::V3_LAYOUT_VERSION.to_le_bytes()
        || core_bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET]
            != DelegationStatus::Delegated as u8
        || core_u64(core_bytes, v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET)? != sequence
        || core_bytes[v3::V3_CORE_MARKET_AUTHORITY_OFFSET
            ..v3::V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != accounts[1].address().to_bytes()
    {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }
    let core_key = *accounts[5].address();
    let bytes = unsafe { accounts[0].borrow_unchecked() };
    if bytes.len() < 44 || bytes[12..44] != core_key.to_bytes() {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    let valid_address = if bytes[0..8] == v3::V3_BOOK_PAGE_DISCRIMINATOR {
        bytes[10] < 2
            && bytes[11] < v3::V3_BOOK_PAGES_PER_SIDE as u8
            && *accounts[0].address()
                == v3::derive_book_page_v3(
                    program_id,
                    &core_key,
                    bytes[10],
                    bytes[11],
                )
    } else if bytes[0..8] == v3::V3_SEAT_SHARD_DISCRIMINATOR {
        bytes[10] < v3::V3_SEAT_SHARDS as u8
            && *accounts[0].address()
                == v3::derive_seat_shard_v3(program_id, &core_key, bytes[10])
    } else if bytes[0..8] == v3::V3_EVENT_SHARD_DISCRIMINATOR {
        bytes[10] < v3::V3_EVENT_SHARDS as u8
            && *accounts[0].address()
                == v3::derive_event_shard_v3(program_id, &core_key, bytes[10])
    } else {
        false
    };
    if !valid_address {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }

    let mut data_buf = [0u8; SCHEDULE_DATA_MAX_LEN];
    let data_len = encode_schedule_intent_bundle_data(
        &[2],
        matches!(kind, CommitKind::CommitAndUndelegate),
        &mut data_buf,
    )
    .map_err(custom)?;
    let commit_accounts = [
        InstructionAccount::writable_signer(accounts[2].address()),
        InstructionAccount::writable(accounts[3].address()),
        InstructionAccount::writable(accounts[0].address()),
    ];
    let commit_ix = InstructionView {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &commit_accounts,
        data: &data_buf[..data_len],
    };
    let commit_views: [&AccountView; 3] = [&accounts[2], &accounts[3], &accounts[0]];
    invoke_signed_with_bounds::<3, _>(&commit_ix, &commit_views, &[])?;

    let core = unsafe { accounts[5].borrow_unchecked_mut() };
    core[v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET
        ..v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET + 8]
        .copy_from_slice(&sequence.to_le_bytes());
    core[v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET
        ..v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET + 8]
        .copy_from_slice(&sequence.saturating_add(1).to_le_bytes());
    Ok(())
}

/// Commit the V3 core alone after all child shards have been committed. This
/// is also the final undelegation request for the core; child undelegations are
/// submitted independently through `commit_v3_member`.
fn commit_v3_core(
    _program_id: &Address,
    accounts: &mut [AccountView],
    sequence: u64,
    kind: CommitKind,
) -> ProgramResult {
    if accounts.len() != 5
        || !accounts[1].is_signer()
        || !accounts[2].is_signer()
        || !accounts[2].is_writable()
        || !accounts[0].is_writable()
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != MAGIC_CONTEXT_ID
        || !accounts[3].is_writable()
        || *accounts[4].address() != MAGIC_PROGRAM_ID
    {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if sequence == 0 {
        return Err(custom(StockStreamError::MagicBlockSequenceReplay));
    }
    {
        let bytes = unsafe { accounts[0].borrow_unchecked() };
        if bytes.len() != v3::V3_MARKET_CORE_SIZE
            || bytes[0..8] != v3::V3_MARKET_CORE_DISCRIMINATOR
            || bytes[8..10] != v3::V3_LAYOUT_VERSION.to_le_bytes()
            || (bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET] != DelegationStatus::Delegated as u8
                && !(matches!(kind, CommitKind::CommitAndUndelegate)
                    && bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET]
                        == DelegationStatus::Undelegating as u8))
        {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
        if core_u64(bytes, v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET)? != sequence {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
        if bytes[v3::V3_CORE_MARKET_AUTHORITY_OFFSET
            ..v3::V3_CORE_MARKET_AUTHORITY_OFFSET + 32]
            != accounts[1].address().to_bytes()
        {
            return Err(custom(StockStreamError::MagicBlockSequenceReplay));
        }
    }
    // An account included in an undelegation intent becomes externally
    // owned by the MagicBlock scheduler during the CPI. Write the final
    // state before invoking it; if scheduling fails the transaction rolls
    // back, so no partially-undelegated state can persist.
    if matches!(kind, CommitKind::CommitAndUndelegate) {
        let bytes = unsafe { accounts[0].borrow_unchecked_mut() };
        bytes[v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET
            ..v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET + 8]
            .copy_from_slice(&sequence.to_le_bytes());
        bytes[v3::V3_CORE_DELEGATION_STATUS_OFFSET] = DelegationStatus::Undelegating as u8;
    }
    let mut data_buf = [0u8; SCHEDULE_DATA_MAX_LEN];
    let data_len = encode_schedule_intent_bundle_data(
        &[2],
        matches!(kind, CommitKind::CommitAndUndelegate),
        &mut data_buf,
    )
    .map_err(custom)?;
    let commit_accounts = [
        InstructionAccount::writable_signer(accounts[2].address()),
        InstructionAccount::writable(accounts[3].address()),
        InstructionAccount::writable(accounts[0].address()),
    ];
    let commit_ix = InstructionView {
        program_id: &MAGIC_PROGRAM_ID,
        accounts: &commit_accounts,
        data: &data_buf[..data_len],
    };
    let commit_views: [&AccountView; 3] = [&accounts[2], &accounts[3], &accounts[0]];
    invoke_signed_with_bounds::<3, _>(&commit_ix, &commit_views, &[])?;
    let bytes = unsafe { accounts[0].borrow_unchecked_mut() };
    if matches!(kind, CommitKind::CommitOnly) {
        bytes[v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET
            ..v3::V3_CORE_LAST_COMMITTED_SEQUENCE_OFFSET + 8]
            .copy_from_slice(&sequence.to_le_bytes());
        bytes[v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET
            ..v3::V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET + 8]
            .copy_from_slice(&sequence.saturating_add(1).to_le_bytes());
    }
    Ok(())
}

fn core_u64(bytes: &[u8], offset: usize) -> Result<u64, ProgramError> {
    bytes
        .get(offset..offset + 8)
        .ok_or(ProgramError::InvalidAccountData)
        .and_then(|raw| raw.try_into().map_err(|_| ProgramError::InvalidAccountData))
        .map(u64::from_le_bytes)
}

// ---------------------------------------------------------------------
// External-undelegate callback
// ---------------------------------------------------------------------

/// Accounts, exactly as constructed by the delegation program's
/// `processor/fast/undelegate.rs::cpi_external_undelegate` (fetched from
/// `magicblock-labs/delegation-program` during implementation -- this is not
/// StockStream's choice, it is the delegation program's fixed wire format):
/// 0. `[WRITE]`          the market PDA (closed by the delegation program; this CPI must recreate it)
/// 1. `[WRITE, SIGNER]`  the undelegate-buffer PDA, holding the final committed state
/// 2. `[WRITE, SIGNER]`  the validator identity that is closing out the delegation
/// 3. `[]`               the system program
///
/// The buffer being a *signer* is the actual proof this call came from the
/// delegation program: it is a PDA under `["undelegate-buffer", market]`
/// owned by `DELEGATION_PROGRAM_ID`, so only that program can produce a
/// valid `invoke_signed` for it. Solana does not otherwise expose "which
/// program CPI'd me" to a callee, so this signer check -- not the
/// discriminator alone -- is what rejects a forged callback.
pub fn external_undelegate(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() != 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // The seeds payload length selects which delegated account kind this
    // callback restores (market 55 / scratch 60 / session 137 seed bytes).
    // V3 core seed payloads are shorter than the legacy market payload; the
    // parser below is the discriminator/shape gate for every supported kind.
    if data.len() < 8 + 1
        || data.len() > EXTERNAL_UNDELEGATE_DATA_LEN
        || data[0..8] != EXTERNAL_UNDELEGATE_DISCRIMINATOR
    {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let kind = parse_delegated_seeds(&data[8..])
        .ok_or(custom(StockStreamError::MagicBlockInvalidCallback))?;

    if !accounts[0].is_writable() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    if !accounts[1].is_signer() || !accounts[1].is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !accounts[2].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *accounts[3].address() != pinocchio_system::ID {
        return Err(custom(StockStreamError::MagicBlockInvalidAccount));
    }
    if accounts[0].owned_by(program_id) {
        // An account this program still owns was never actually handed to
        // the delegation program's undelegate flow; recreating it here would
        // silently overwrite live state.
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }

    // The undelegate buffer must be the delegation program's own PDA for
    // this exact account: the buffer being a *signer* is the proof this call
    // came from the delegation program (only that program can produce a
    // valid `invoke_signed` for it).
    let (expected_buffer, _) = Address::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, accounts[0].address().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if expected_buffer != *accounts[1].address() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }

    // The account's PDA must re-derive from the exact seeds the delegation
    // program replayed back, and its final committed size must match the
    // buffer. This is the restoration-mismatch gate: a buffer from a
    // different delegation (or a tampered one) never passes.
    match kind {
        DelegatedAccountKind::Market => {
            // seeds = ["perp-market", instrument]
            let payload = &data[8..8 + MARKET_SEEDS_PAYLOAD_LEN];
            let instrument_bytes: [u8; 32] = payload[payload.len() - 32..]
                .try_into()
                .map_err(|_| custom(StockStreamError::MagicBlockInvalidCallback))?;
            let instrument = Address::new_from_array(instrument_bytes);
            let (expected_market, market_bump) =
                Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], program_id);
            if expected_market != *accounts[0].address()
                || accounts[1].data_len() != state::MARKET_ACCOUNT_SIZE
            {
                return Err(custom(StockStreamError::MagicBlockInvalidCallback));
            }

            let market_bump_slice = [market_bump];
            let market_signer_seeds = [
                Seed::from(PERP_MARKET_SEED),
                Seed::from(instrument.as_ref()),
                Seed::from(&market_bump_slice),
            ];
            let market_signer = Signer::from(&market_signer_seeds);
            {
                let (account, rest) = accounts.split_at_mut(1);
                recreate_account_from_buffer(
                    &mut account[0],
                    &rest[0],
                    &rest[1],
                    &market_signer,
                    program_id,
                )?;
            }

            // Verify and finalize the lifecycle fields the market header
            // carries (they were stamped by `commit_and_undelegate_market`
            // before the last commit and survive the round trip through the
            // buffer).
            let market_key = accounts[0].address().to_bytes();
            let data = market_data(&mut accounts[0], program_id)?;
            let mut header = initialized_header(data)?;
            if header.delegation_status() != DelegationStatus::Undelegating as u8
                || !header.pending_undelegation()
            {
                return Err(custom(StockStreamError::MagicBlockInvalidCallback));
            }
            let final_sequence = header.expected_final_commit_sequence();
            // `RestorationPending` and `MarketRestored` both fall inside this
            // one callback instruction (the delegation program's undelegate
            // CPI hands back the fully-committed account atomically -- there
            // is no separate, on-chain-observable "pending" phase between
            // them), so they are emitted back to back rather than across two
            // instructions, the same pattern already used for
            // `LiquidationStarted`/`PositionLiquidated` and
            // `DelegationRequested`/`MarketDelegated`.
            let pending_sequence = header
                .global_event_sequence
                .checked_add(1)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
            header.global_event_sequence = pending_sequence;
            let validator = header.validator();
            crate::events::emit_event(
                crate::events::EventKind::RestorationPending,
                &market_key,
                pending_sequence,
                event_timestamp(),
                &crate::events::payload_delegation(&validator, final_sequence),
            );
            header.set_delegation_status(DelegationStatus::Restored);
            header.set_pending_undelegation(false);
            header.set_last_committed_sequence(final_sequence);
            let event_sequence = header
                .global_event_sequence
                .checked_add(1)
                .ok_or(custom(StockStreamError::ArithmeticOverflow))?;
            header.global_event_sequence = event_sequence;
            write_header(data, &header)?;
            crate::events::emit_event(
                crate::events::EventKind::MarketRestored,
                &market_key,
                event_sequence,
                event_timestamp(),
                &crate::events::payload_delegation(&validator, final_sequence),
            );
            Ok(())
        }
        DelegatedAccountKind::Scratch { market, seat } => {
            let expected_scratch = derive_settlement_scratch(&market, seat, program_id);
            if expected_scratch != *accounts[0].address()
                || accounts[1].data_len() != SETTLEMENT_SCRATCH_LEN
            {
                return Err(custom(StockStreamError::MagicBlockInvalidCallback));
            }
            let seat_le = seat.to_le_bytes();
            let (_, bump) = Address::find_program_address(
                &[scratch::SETTLEMENT_SEED, market.as_ref(), &seat_le],
                program_id,
            );
            let bump_slice = [bump];
            let scratch_signer_seed_array = [
                Seed::from(scratch::SETTLEMENT_SEED),
                Seed::from(market.as_ref()),
                Seed::from(&seat_le),
                Seed::from(&bump_slice),
            ];
            let scratch_signer = Signer::from(&scratch_signer_seed_array);
            {
                let (account, rest) = accounts.split_at_mut(1);
                recreate_account_from_buffer(
                    &mut account[0],
                    &rest[0],
                    &rest[1],
                    &scratch_signer,
                    program_id,
                )?;
            }
            // Restoration-mismatch detection: a committed scratch must be
            // `Empty` (the boundary gate guarantees no plan ever crossed the
            // delegation boundary), initialized, and bound to this market.
            {
                let bytes = unsafe { accounts[0].borrow_unchecked() };
                validate_restored_scratch(&bytes, &market, seat)?;
            }
            Ok(())
        }
        DelegatedAccountKind::Session {
            owner,
            market,
            seat,
            session_signer,
        } => {
            let expected_session =
                session::derive_trading_session(&owner, &market, seat, &session_signer, program_id);
            if expected_session != *accounts[0].address()
                || accounts[1].data_len() != session::TRADING_SESSION_SIZE
            {
                return Err(custom(StockStreamError::MagicBlockInvalidCallback));
            }
            let seat_le = seat.to_le_bytes();
            let (_, bump) = Address::find_program_address(
                &[
                    session::TRADING_SESSION_SEED,
                    owner.as_ref(),
                    market.as_ref(),
                    &seat_le,
                    session_signer.as_ref(),
                ],
                program_id,
            );
            let bump_slice = [bump];
            let session_signer_seed_array = [
                Seed::from(session::TRADING_SESSION_SEED),
                Seed::from(owner.as_ref()),
                Seed::from(market.as_ref()),
                Seed::from(&seat_le),
                Seed::from(session_signer.as_ref()),
                Seed::from(&bump_slice),
            ];
            let session_callback_signer = Signer::from(&session_signer_seed_array);
            {
                let (account, rest) = accounts.split_at_mut(1);
                recreate_account_from_buffer(
                    &mut account[0],
                    &rest[0],
                    &rest[1],
                    &session_callback_signer,
                    program_id,
                )?;
            }
            // Restoration-mismatch detection: the restored session must be a
            // valid, initialized session for the exact (owner, market, seat,
            // signer) tuple its delegation seeds claim.
            {
                let bytes = unsafe { accounts[0].borrow_unchecked() };
                validate_restored_session(
                    &bytes,
                    &owner,
                    &market,
                    seat,
                    &session_signer,
                    program_id,
                )?;
            }
            Ok(())
        }
        DelegatedAccountKind::V3Core { instrument } => {
            let expected = v3::derive_market_core_v3(program_id, &instrument);
            let (_, bump) = Address::find_program_address(
                &[v3::V3_MARKET_CORE_SEED, instrument.as_ref()],
                program_id,
            );
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_MARKET_CORE_SEED),
                Seed::from(instrument.as_ref()),
                Seed::from(&bump_slice),
            ];
            restore_v3_callback_account(
                accounts,
                &expected,
                v3::V3_MARKET_CORE_SIZE,
                &Signer::from(&seeds),
                program_id,
            )?;
            validate_restored_v3_account(
                unsafe { accounts[0].borrow_unchecked() },
                v3::V3AccountKind::MarketCore,
                &instrument,
                0,
            )
        }
        DelegatedAccountKind::V3BookPage { core, side, page } => {
            let expected = v3::derive_book_page_v3(program_id, &core, side, page);
            let (_, bump) = Address::find_program_address(
                &[v3::V3_BOOK_PAGE_SEED, core.as_ref(), &[side], &[page]],
                program_id,
            );
            let side_slice = [side];
            let page_slice = [page];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_BOOK_PAGE_SEED),
                Seed::from(core.as_ref()),
                Seed::from(&side_slice),
                Seed::from(&page_slice),
                Seed::from(&bump_slice),
            ];
            restore_v3_callback_account(
                accounts,
                &expected,
                v3::V3_BOOK_PAGE_SIZE,
                &Signer::from(&seeds),
                program_id,
            )?;
            validate_restored_v3_account(
                unsafe { accounts[0].borrow_unchecked() },
                v3::V3AccountKind::BookPage,
                &core,
                side * v3::V3_BOOK_PAGES_PER_SIDE as u8 + page,
            )
        }
        DelegatedAccountKind::V3SeatShard { core, shard } => {
            let expected = v3::derive_seat_shard_v3(program_id, &core, shard);
            let (_, bump) = Address::find_program_address(
                &[v3::V3_SEAT_SHARD_SEED, core.as_ref(), &[shard]],
                program_id,
            );
            let shard_slice = [shard];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_SEAT_SHARD_SEED),
                Seed::from(core.as_ref()),
                Seed::from(&shard_slice),
                Seed::from(&bump_slice),
            ];
            restore_v3_callback_account(
                accounts,
                &expected,
                v3::V3_SEAT_SHARD_SIZE,
                &Signer::from(&seeds),
                program_id,
            )?;
            validate_restored_v3_account(
                unsafe { accounts[0].borrow_unchecked() },
                v3::V3AccountKind::SeatShard,
                &core,
                shard,
            )
        }
        DelegatedAccountKind::V3EventShard { core, shard } => {
            let expected = v3::derive_event_shard_v3(program_id, &core, shard);
            let (_, bump) = Address::find_program_address(
                &[v3::V3_EVENT_SHARD_SEED, core.as_ref(), &[shard]],
                program_id,
            );
            let shard_slice = [shard];
            let bump_slice = [bump];
            let seeds = [
                Seed::from(v3::V3_EVENT_SHARD_SEED),
                Seed::from(core.as_ref()),
                Seed::from(&shard_slice),
                Seed::from(&bump_slice),
            ];
            restore_v3_callback_account(
                accounts,
                &expected,
                v3::V3_EVENT_SHARD_SIZE,
                &Signer::from(&seeds),
                program_id,
            )?;
            validate_restored_v3_account(
                unsafe { accounts[0].borrow_unchecked() },
                v3::V3AccountKind::EventShard,
                &core,
                shard,
            )
        }
    }
}

fn restore_v3_callback_account(
    accounts: &mut [AccountView],
    expected: &Address,
    expected_len: usize,
    signer: &Signer,
    program_id: &Address,
) -> ProgramResult {
    if *accounts[0].address() != *expected || accounts[1].data_len() != expected_len {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let (account, rest) = accounts.split_at_mut(1);
    recreate_account_from_buffer(&mut account[0], &rest[0], &rest[1], signer, program_id)
}

/// Checks the recovered bytes against the exact V3 PDA tuple replayed by the
/// delegation program. The core must remain activated; children carry their
/// parent core in the account header, so a valid page cannot be substituted
/// for a sibling at restoration time.
pub fn validate_restored_v3_account(
    bytes: &[u8],
    kind: v3::V3AccountKind,
    parent: &Address,
    index: u8,
) -> ProgramResult {
    if bytes.len() != kind.account_size() {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    let valid = match kind {
        v3::V3AccountKind::MarketCore => {
            bytes[0..8] == v3::V3_MARKET_CORE_DISCRIMINATOR
                && bytes[8..10] == v3::V3_LAYOUT_VERSION.to_le_bytes()
                && bytes[10] == 1
                && bytes[11] == 1
                && bytes[12..44] == *parent.as_ref()
        }
        v3::V3AccountKind::BookPage => {
            bytes[0..8] == v3::V3_BOOK_PAGE_DISCRIMINATOR
                && bytes[8..10] == v3::V3_LAYOUT_VERSION.to_le_bytes()
                && bytes[10] == index / v3::V3_BOOK_PAGES_PER_SIDE as u8
                && bytes[11] == index % v3::V3_BOOK_PAGES_PER_SIDE as u8
                && bytes[12..44] == *parent.as_ref()
        }
        v3::V3AccountKind::SeatShard => {
            bytes[0..8] == v3::V3_SEAT_SHARD_DISCRIMINATOR
                && bytes[8..10] == v3::V3_LAYOUT_VERSION.to_le_bytes()
                && bytes[10] == index
                && bytes[12..44] == *parent.as_ref()
        }
        v3::V3AccountKind::EventShard => {
            bytes[0..8] == v3::V3_EVENT_SHARD_DISCRIMINATOR
                && bytes[8..10] == v3::V3_LAYOUT_VERSION.to_le_bytes()
                && bytes[10] == index
                && bytes[12..44] == *parent.as_ref()
        }
    };
    valid
        .then_some(())
        .ok_or(custom(StockStreamError::MagicBlockInvalidCallback))
}

/// Restoration-mismatch detection for a restored scratch account: a
/// committed scratch must be initialized, `Empty` (the boundary gate
/// guarantees no plan ever crossed the delegation boundary), and bound to
/// this exact market and seat.
pub fn validate_restored_scratch(
    bytes: &[u8],
    market: &Address,
    seat: u16,
) -> Result<(), ProgramError> {
    let header = read_scratch_header(bytes)?;
    if header.discriminator != scratch::SETTLEMENT_SCRATCH_DISCRIMINATOR
        || header.version != scratch::SETTLEMENT_SCRATCH_VERSION
        || header.initialized != 1
        || header.status != ScratchStatus::Empty as u8
        || header.market != market.to_bytes()
        || header.trader_seat_index != seat
    {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    Ok(())
}

/// Restoration-mismatch detection for a restored `TradingSession` account:
/// the restored bytes must be a valid, initialized session for the exact
/// (owner, market, seat, signer) tuple its delegation seeds claim.
pub fn validate_restored_session(
    bytes: &[u8],
    owner: &Address,
    market: &Address,
    seat: u16,
    session_signer: &Address,
    program_id: &Address,
) -> Result<(), ProgramError> {
    let restored = session::read_session(bytes)?;
    if restored.discriminator != session::TRADING_SESSION_DISCRIMINATOR
        || restored.version != session::TRADING_SESSION_VERSION
        || restored.initialized != 1
        || restored.target_program != program_id.to_bytes()
        || restored.owner != owner.to_bytes()
        || restored.market != market.to_bytes()
        || restored.session_signer != session_signer.to_bytes()
        || restored.trader_seat_index != seat
    {
        return Err(custom(StockStreamError::MagicBlockInvalidCallback));
    }
    Ok(())
}

/// Re-creates an undelegated account (the delegation program closed it
/// before this CPI: 0 lamports, 0-length data, owned by the system program)
/// from the undelegate buffer, funded to exactly the rent-exempt minimum by
/// the validator -- the delegation program asserts afterwards that the
/// validator's lamports dropped by exactly that amount, so this must not be
/// more or less.
fn recreate_account_from_buffer(
    account: &mut AccountView,
    buffer: &AccountView,
    payer: &AccountView,
    account_signer: &Signer,
    program_id: &Address,
) -> ProgramResult {
    let rent = Rent::get()?;
    let buffer_len = buffer.data_len();
    CreateAccount {
        from: payer,
        to: account,
        lamports: rent.try_minimum_balance(buffer_len)?,
        space: buffer_len as u64,
        owner: program_id,
    }
    .invoke_signed(core::slice::from_ref(account_signer))?;
    {
        let buffer_bytes = buffer.try_borrow()?;
        let account_bytes = unsafe { account.borrow_unchecked_mut() };
        account_bytes.copy_from_slice(&buffer_bytes);
    }
    Ok(())
}
