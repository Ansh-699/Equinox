//! Per-trader settlement working memory.
//!
//! A scratch account is derived for one `(market, trader-seat)` pair and is
//! writable only for the duration of a single `PlaceOrder` instruction.  It is
//! deliberately not a deferred-plan account: successful instructions clear it
//! back to `Empty`, and no instruction accepts `Ready` as authority to apply a
//! prior plan.  The byte layout is explicit because Solana account data is not
//! assumed to be naturally aligned for Rust structs.

use core::{
    mem::{align_of, size_of},
    ptr,
};

use pinocchio::{error::ProgramError, Address};

use crate::{
    book::PlannedMatch,
    error::StockStreamError,
    state::{FillEvent, TraderSeat},
};

pub const SETTLEMENT_SCRATCH_DISCRIMINATOR: [u8; 8] = *b"STKSCR01";
pub const SETTLEMENT_SCRATCH_VERSION: u16 = 1;
pub const SETTLEMENT_SCRATCH_ALIGNMENT: usize = 8;
pub const MAX_SCRATCH_SEAT_RESULTS: usize = 5; // taker plus four makers
pub const MAX_SCRATCH_EVENTS: usize = 4;
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

pub fn derive_settlement_scratch(market: &Address, seat: u16, program_id: &Address) -> Address {
    let seat_bytes = seat.to_le_bytes();
    Address::find_program_address(&[SETTLEMENT_SEED, market.as_ref(), &seat_bytes], program_id).0
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScratchStatus {
    Empty = 0,
    Planning = 1,
    Ready = 2,
    Applying = 3,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SettlementScratchHeader {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub status: u8,
    pub market: [u8; 32],
    pub trader: [u8; 32],
    pub authority: [u8; 32],
    pub trader_seat_index: u16,
    pub plan_nonce: u64,
    pub expected_order_sequence: u64,
    pub expected_event_sequence: u64,
    pub expected_oracle_timestamp: u64,
    pub expected_funding_timestamp: u64,
    pub fill_count: u8,
    pub invalid_removal_count: u8,
    pub expired_removal_count: u8,
    pub seat_result_count: u8,
    pub event_count: u8,
    pub _padding: [u8; 3],
    pub seat_result_indices: [u16; MAX_SCRATCH_SEAT_RESULTS],
    pub plan_byte_len: u32,
    pub checksum: u64,
    pub open_interest_after: i128,
    pub final_order_sequence: u64,
    pub final_event_sequence: u64,
    pub reserved_upgrade: [u8; 54],
}

pub const SETTLEMENT_SCRATCH_HEADER_SIZE: usize = size_of::<SettlementScratchHeader>();
/// Physical header region. The logical header is packed and decoded as bytes;
/// this explicit padding keeps the following typed plan region 8-byte aligned.
pub const SETTLEMENT_SCRATCH_HEADER_PHYSICAL_SIZE: usize =
    align_up(SETTLEMENT_SCRATCH_HEADER_SIZE, SETTLEMENT_SCRATCH_ALIGNMENT);
pub const SETTLEMENT_PLAN_OFFSET: usize = SETTLEMENT_SCRATCH_HEADER_PHYSICAL_SIZE;
pub const SETTLEMENT_PLAN_SIZE: usize = size_of::<PlannedMatch>();
pub const SETTLEMENT_SEAT_RESULTS_OFFSET: usize = align_up(
    SETTLEMENT_PLAN_OFFSET + SETTLEMENT_PLAN_SIZE,
    align_of::<TraderSeat>(),
);
pub const SETTLEMENT_EVENTS_OFFSET: usize = align_up(
    SETTLEMENT_SEAT_RESULTS_OFFSET + MAX_SCRATCH_SEAT_RESULTS * size_of::<TraderSeat>(),
    align_of::<FillEvent>(),
);
pub const SETTLEMENT_SCRATCH_LEN: usize = align_up(
    SETTLEMENT_EVENTS_OFFSET + MAX_SCRATCH_EVENTS * size_of::<FillEvent>(),
    SETTLEMENT_SCRATCH_ALIGNMENT,
);

const _: [(); 266] = [(); SETTLEMENT_SCRATCH_HEADER_SIZE];
const _: [(); 272] = [(); SETTLEMENT_SCRATCH_HEADER_PHYSICAL_SIZE];
const _: [(); 0] = [(); SETTLEMENT_PLAN_OFFSET % align_of::<PlannedMatch>()];
const _: [(); 0] = [(); SETTLEMENT_SEAT_RESULTS_OFFSET % align_of::<TraderSeat>()];
const _: [(); 0] = [(); SETTLEMENT_EVENTS_OFFSET % align_of::<FillEvent>()];
const _: [(); 1] = [(); (SETTLEMENT_SCRATCH_LEN <= 12 * 1024) as usize];

const fn align_up(value: usize, alignment: usize) -> usize {
    (value + alignment - 1) & !(alignment - 1)
}

impl SettlementScratchHeader {
    pub const fn empty(market: [u8; 32], trader: [u8; 32], seat: u16) -> Self {
        Self {
            discriminator: SETTLEMENT_SCRATCH_DISCRIMINATOR,
            version: SETTLEMENT_SCRATCH_VERSION,
            initialized: 1,
            status: ScratchStatus::Empty as u8,
            market,
            trader,
            authority: trader,
            trader_seat_index: seat,
            plan_nonce: 0,
            expected_order_sequence: 0,
            expected_event_sequence: 0,
            expected_oracle_timestamp: 0,
            expected_funding_timestamp: 0,
            fill_count: 0,
            invalid_removal_count: 0,
            expired_removal_count: 0,
            seat_result_count: 0,
            event_count: 0,
            _padding: [0; 3],
            seat_result_indices: [u16::MAX; MAX_SCRATCH_SEAT_RESULTS],
            plan_byte_len: SETTLEMENT_PLAN_SIZE as u32,
            checksum: 0,
            open_interest_after: 0,
            final_order_sequence: 0,
            final_event_sequence: 0,
            reserved_upgrade: [0; 54],
        }
    }

    pub fn validate(&self, market: [u8; 32], trader: [u8; 32], seat: u16) -> bool {
        self.discriminator == SETTLEMENT_SCRATCH_DISCRIMINATOR
            && self.version == SETTLEMENT_SCRATCH_VERSION
            && self.initialized == 1
            && self.status <= ScratchStatus::Applying as u8
            && self.market == market
            && self.trader == trader
            && self.authority == trader
            && self.trader_seat_index == seat
            && self.plan_byte_len as usize == SETTLEMENT_PLAN_SIZE
            && self.fill_count as usize <= MAX_SCRATCH_EVENTS
            && self.seat_result_count as usize <= MAX_SCRATCH_SEAT_RESULTS
            && self.event_count as usize <= MAX_SCRATCH_EVENTS
    }
}

/// Borrowed, validated scratch bytes. The view is intentionally small and
/// never owns a `SettlementPlan`; all large state remains in account data.
pub struct SettlementScratchView<'a> {
    data: &'a mut [u8],
}

impl<'a> SettlementScratchView<'a> {
    pub fn new(data: &'a mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != SETTLEMENT_SCRATCH_LEN
            || (data.as_ptr() as usize) % SETTLEMENT_SCRATCH_ALIGNMENT != 0
        {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        Ok(Self { data })
    }

    pub fn read_header(&self) -> SettlementScratchHeader {
        read_copy(self.data, 0)
    }

    pub fn write_header(&mut self, header: &SettlementScratchHeader) {
        write_copy(self.data, 0, header);
    }

    pub fn initialize(&mut self, market: [u8; 32], trader: [u8; 32], seat: u16) {
        self.data.fill(0);
        self.write_header(&SettlementScratchHeader::empty(market, trader, seat));
    }

    pub fn begin(
        &mut self,
        market: [u8; 32],
        trader: [u8; 32],
        seat: u16,
    ) -> Result<u64, ProgramError> {
        let mut header = self.read_header();
        if !header.validate(market, trader, seat) || header.status != ScratchStatus::Empty as u8 {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        header.plan_nonce = header
            .plan_nonce
            .checked_add(1)
            .ok_or(StockStreamError::ArithmeticOverflow)?;
        header.status = ScratchStatus::Planning as u8;
        self.write_header(&header);
        Ok(header.plan_nonce)
    }

    pub fn plan_mut(&mut self) -> &mut PlannedMatch {
        // SAFETY: `new` checked exact account size and 8-byte base alignment;
        // the compile-time offset is aligned for `PlannedMatch`. The region is
        // exclusive to this view and is initialized before it is read.
        unsafe { &mut *(self.data.as_mut_ptr().add(SETTLEMENT_PLAN_OFFSET) as *mut PlannedMatch) }
    }

    pub fn plan(&self) -> &PlannedMatch {
        // SAFETY: see `plan_mut`; callers only read after planning has filled
        // every field of the plan at the aligned fixed offset.
        unsafe { &*(self.data.as_ptr().add(SETTLEMENT_PLAN_OFFSET) as *const PlannedMatch) }
    }

    pub fn write_seat_result(
        &mut self,
        index: usize,
        seat: &TraderSeat,
    ) -> Result<(), ProgramError> {
        if index >= MAX_SCRATCH_SEAT_RESULTS {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        write_copy(
            self.data,
            SETTLEMENT_SEAT_RESULTS_OFFSET + index * size_of::<TraderSeat>(),
            seat,
        );
        Ok(())
    }

    pub fn seat_result(&self, index: usize) -> Result<TraderSeat, ProgramError> {
        if index >= MAX_SCRATCH_SEAT_RESULTS {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        Ok(read_copy(
            self.data,
            SETTLEMENT_SEAT_RESULTS_OFFSET + index * size_of::<TraderSeat>(),
        ))
    }

    pub fn write_event(&mut self, index: usize, event: &FillEvent) -> Result<(), ProgramError> {
        if index >= MAX_SCRATCH_EVENTS {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        write_copy(
            self.data,
            SETTLEMENT_EVENTS_OFFSET + index * size_of::<FillEvent>(),
            event,
        );
        Ok(())
    }

    pub fn event(&self, index: usize) -> Result<FillEvent, ProgramError> {
        if index >= MAX_SCRATCH_EVENTS {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        Ok(read_copy(
            self.data,
            SETTLEMENT_EVENTS_OFFSET + index * size_of::<FillEvent>(),
        ))
    }

    pub fn clear(&mut self) {
        let mut header = self.read_header();
        let nonce = header.plan_nonce;
        let market = header.market;
        let trader = header.trader;
        let seat = header.trader_seat_index;
        self.data[SETTLEMENT_PLAN_OFFSET..].fill(0);
        header = SettlementScratchHeader::empty(market, trader, seat);
        header.plan_nonce = nonce;
        self.write_header(&header);
    }

    /// Restores the empty pre-instruction scratch state for predictable
    /// pre-apply rejections in native account tests. Runtime failures still
    /// receive Solana's instruction-level rollback.
    pub fn abort_to(&mut self, header: &SettlementScratchHeader) {
        self.data[SETTLEMENT_PLAN_OFFSET..].fill(0);
        self.write_header(header);
    }

    pub fn set_seat_result_index(
        &mut self,
        slot: usize,
        seat_index: u16,
    ) -> Result<(), ProgramError> {
        if slot >= MAX_SCRATCH_SEAT_RESULTS {
            return Err(StockStreamError::InvalidSettlementScratch.into());
        }
        let mut header = self.read_header();
        header.seat_result_indices[slot] = seat_index;
        if header.seat_result_count <= slot as u8 {
            header.seat_result_count = slot as u8 + 1;
        }
        self.write_header(&header);
        Ok(())
    }
}

fn read_copy<T: Copy>(data: &[u8], offset: usize) -> T {
    let mut value = core::mem::MaybeUninit::<T>::uninit();
    // SAFETY: every caller uses a compile-time region within the exact checked
    // scratch length. `copy_nonoverlapping` permits unaligned source bytes.
    unsafe {
        ptr::copy_nonoverlapping(
            data.as_ptr().add(offset),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<T>(),
        );
        value.assume_init()
    }
}

fn write_copy<T>(data: &mut [u8], offset: usize, value: &T) {
    // SAFETY: every caller uses a compile-time region within the exact checked
    // scratch length. The destination does not alias the stack value.
    unsafe {
        ptr::copy_nonoverlapping(
            (value as *const T).cast::<u8>(),
            data.as_mut_ptr().add(offset),
            size_of::<T>(),
        );
    }
}
