use core::mem::size_of;

pub const MARKET_DISCRIMINATOR: [u8; 8] = *b"STKMRK01";
/// `1`: the pre-Priority-4 layout, where every byte of `reserved_upgrade`
/// past the MagicBlock/oracle fields (bytes `122..185`) was unused scratch
/// space with no defined interpretation.
///
/// `2` (current): bytes `122..155` of `reserved_upgrade` are permanent
/// protocol fields (`protocol_fee_balance`, `insurance_fund_balance`,
/// `recognized_bad_debt`, `reconciliation_status`, `vault_surplus` -- see
/// `docs/custody.md`/`docs/program-layout.md`). `validate()` below rejects
/// any header whose stored `version` does not equal the version this build
/// was compiled against, so a `1`-tagged account is never silently
/// reinterpreted under the `2` layout (or vice versa). No live migration
/// instruction exists because no market has ever been deployed under
/// version `1`; if one ever is, a version-1-to-2 migration would need to
/// explicitly zero-initialize the new fields (their sensible defaults) and
/// rewrite the stored version, rather than being inferred implicitly.
pub const MARKET_VERSION: u16 = 2;
pub const MARKET_HEADER_SIZE: usize = 512;
pub const MAX_TRADER_SEATS: usize = 128;
pub const TRADER_SEAT_SIZE: usize = 256;
pub const TRADER_SEAT_REGION_SIZE: usize = MAX_TRADER_SEATS * TRADER_SEAT_SIZE;
pub const FILL_EVENT_SIZE: usize = 64;
pub const FILL_EVENT_CAPACITY: usize = 128;
pub const FILL_EVENT_REGION_SIZE: usize = FILL_EVENT_SIZE * FILL_EVENT_CAPACITY;

pub const BID_ARENA_OFFSET: usize = MARKET_HEADER_SIZE;
pub const BID_ARENA_LENGTH: usize = 90_640;
pub const ASK_ARENA_OFFSET: usize = BID_ARENA_OFFSET + BID_ARENA_LENGTH;
pub const ASK_ARENA_LENGTH: usize = 90_640;
pub const TRADER_SEAT_OFFSET: usize = ASK_ARENA_OFFSET + ASK_ARENA_LENGTH;
pub const FILL_EVENT_OFFSET: usize = TRADER_SEAT_OFFSET + TRADER_SEAT_REGION_SIZE;
pub const MARKET_ACCOUNT_SIZE: usize = FILL_EVENT_OFFSET + FILL_EVENT_REGION_SIZE;

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct FillEvent {
    pub sequence: u64,
    pub maker_seat: u32,
    pub taker_seat: u32,
    pub price: i64,
    pub quantity: u64,
    pub maker_client_order_id: u64,
    pub timestamp: u64,
    pub reserved: [u8; 16],
}
const _: [(); FILL_EVENT_SIZE] = [(); size_of::<FillEvent>()];

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketMode {
    Paused = 0,
    Open = 1,
    CloseOnly = 2,
    Emergency = 3,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct MarketStateHeader {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub mode: u8,
    pub market_authority: [u8; 32],
    pub pause_authority: [u8; 32],
    pub emergency_authority: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub collateral_token_program: [u8; 32],
    pub price_exponent: i32,
    pub base_lot_size: u64,
    pub quote_lot_size: u64,
    pub initial_margin_bps: u16,
    pub maintenance_margin_bps: u16,
    pub liquidation_fee_bps: u16,
    pub maker_fee_bps: u16,
    pub taker_fee_bps: u16,
    pub maximum_leverage: u32,
    pub maximum_position: i128,
    pub maximum_open_interest: i128,
    pub current_open_interest: i128,
    pub global_order_sequence: u64,
    pub global_event_sequence: u64,
    pub funding_accumulator: i128,
    pub last_funding_timestamp: u64,
    pub oracle_valid: u8,
    pub last_verified_oracle_price: i64,
    pub last_verified_oracle_timestamp: u64,
    pub bid_arena_offset: u32,
    pub ask_arena_offset: u32,
    pub trader_seat_offset: u32,
    pub fill_event_offset: u32,
    pub reserved_upgrade: [u8; 185],
}

const _: [(); MARKET_HEADER_SIZE] = [(); size_of::<MarketStateHeader>()];

impl MarketStateHeader {
    pub const fn empty() -> Self {
        Self {
            discriminator: MARKET_DISCRIMINATOR,
            version: MARKET_VERSION,
            initialized: 0,
            mode: MarketMode::Paused as u8,
            market_authority: [0; 32],
            pause_authority: [0; 32],
            emergency_authority: [0; 32],
            collateral_mint: [0; 32],
            collateral_token_program: [0; 32],
            price_exponent: -6,
            base_lot_size: 1,
            quote_lot_size: 1,
            initial_margin_bps: 2_000,
            maintenance_margin_bps: 1_000,
            liquidation_fee_bps: 50,
            maker_fee_bps: 0,
            taker_fee_bps: 5,
            maximum_leverage: 5,
            maximum_position: 0,
            maximum_open_interest: 0,
            current_open_interest: 0,
            global_order_sequence: 0,
            global_event_sequence: 0,
            funding_accumulator: 0,
            last_funding_timestamp: 0,
            oracle_valid: 0,
            last_verified_oracle_price: 0,
            last_verified_oracle_timestamp: 0,
            bid_arena_offset: BID_ARENA_OFFSET as u32,
            ask_arena_offset: ASK_ARENA_OFFSET as u32,
            trader_seat_offset: TRADER_SEAT_OFFSET as u32,
            fill_event_offset: FILL_EVENT_OFFSET as u32,
            reserved_upgrade: [0; 185],
        }
    }

    pub fn validate(&self, account_len: usize) -> Result<(), LayoutError> {
        if self.discriminator != MARKET_DISCRIMINATOR || self.version != MARKET_VERSION {
            return Err(LayoutError::Header);
        }
        if account_len != MARKET_ACCOUNT_SIZE
            || self.bid_arena_offset as usize != BID_ARENA_OFFSET
            || self.ask_arena_offset as usize != ASK_ARENA_OFFSET
            || self.trader_seat_offset as usize != TRADER_SEAT_OFFSET
            || self.fill_event_offset as usize != FILL_EVENT_OFFSET
        {
            return Err(LayoutError::Region);
        }
        if self.initial_margin_bps == 0
            || self.maintenance_margin_bps == 0
            || self.maintenance_margin_bps > self.initial_margin_bps
            || self.maximum_leverage == 0
        {
            return Err(LayoutError::Value);
        }
        if self.initialized > 1 || self.oracle_valid > 1 || self.mode > MarketMode::Emergency as u8
        {
            return Err(LayoutError::Value);
        }
        if !regions_are_disjoint() {
            return Err(LayoutError::Region);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayoutError {
    Header,
    Region,
    Value,
}

/// MagicBlock Ephemeral Rollup delegation lifecycle status, stored at
/// `reserved_upgrade[RESERVED_DELEGATION_STATUS]`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DelegationStatus {
    /// Never delegated, or fully restored after a completed undelegation.
    /// L1 withdrawals are permitted in this state.
    NotDelegated = 0,
    /// Delegated to the Delegation Program; the market trades on the ER.
    /// L1 withdrawals are blocked.
    Delegated = 1,
    /// `CommitAndUndelegate` has been submitted; awaiting the delegation
    /// program's external-undelegate callback. L1 withdrawals are blocked.
    Undelegating = 2,
    /// The external-undelegate callback has been verified and consumed.
    /// Functionally equivalent to `NotDelegated` for withdrawal purposes but
    /// kept distinct for the on-chain audit trail.
    Restored = 3,
}

impl DelegationStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::NotDelegated),
            1 => Some(Self::Delegated),
            2 => Some(Self::Undelegating),
            3 => Some(Self::Restored),
            _ => None,
        }
    }
}

// Byte offsets of MagicBlock delegation-lifecycle fields within
// `reserved_upgrade`. [0], [1], [32..64], [64..68] and [68] are used by
// custody and oracle configuration (see handlers.rs) and must not overlap.
pub const RESERVED_DELEGATION_STATUS: usize = 2;
pub const RESERVED_EXPECTED_COMMIT_SEQUENCE: usize = 3; // ..11
pub const RESERVED_LAST_COMMITTED_SEQUENCE: usize = 11; // ..19
pub const RESERVED_VALIDATOR: usize = 69; // ..101
pub const RESERVED_DELEGATION_SEQUENCE: usize = 101; // ..109
pub const RESERVED_COMMIT_INTERVAL_MS: usize = 109; // ..113
pub const RESERVED_EXPECTED_FINAL_COMMIT_SEQUENCE: usize = 113; // ..121
pub const RESERVED_PENDING_UNDELEGATION: usize = 121;

// Custody/vault-accounting fields (Priority 4). [122..155] (33 bytes);
// [155..185] (30 bytes) remain free for future upgrades.
pub const RESERVED_PROTOCOL_FEE_BALANCE: usize = 122; // ..130
pub const RESERVED_INSURANCE_FUND_BALANCE: usize = 130; // ..138
pub const RESERVED_RECOGNIZED_BAD_DEBT: usize = 138; // ..146
pub const RESERVED_RECONCILIATION_STATUS: usize = 146;
pub const RESERVED_VAULT_SURPLUS: usize = 147; // ..155

/// Vault reconciliation status, stored at
/// `reserved_upgrade[RESERVED_RECONCILIATION_STATUS]`. See `ReconcileVault`
/// in `handlers.rs` and `docs/custody.md` for the transition rules.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconciliationStatus {
    /// Actual vault token balance exactly matches expected liability, or the
    /// market has never been reconciled yet (the default).
    Reconciled = 0,
    /// Actual vault balance exceeds expected liability. Recorded, not
    /// auto-assigned to any trader.
    SurplusDetected = 1,
    /// Actual vault balance is short of expected liability. New risk is
    /// paused and `WithdrawCollateral` is blocked until this is resolved.
    DeficitDetected = 2,
    /// A deficit was detected on two consecutive reconciliations: governance
    /// must explicitly intervene (`RecordBadDebt`/`ResolveBadDebt`, an
    /// external deposit, etc.) before this can clear.
    RecoveryRequired = 3,
}

impl ReconciliationStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Reconciled),
            1 => Some(Self::SurplusDetected),
            2 => Some(Self::DeficitDetected),
            3 => Some(Self::RecoveryRequired),
            _ => None,
        }
    }
}

impl MarketStateHeader {
    pub fn delegation_status(&self) -> u8 {
        self.reserved_upgrade[RESERVED_DELEGATION_STATUS]
    }

    pub fn set_delegation_status(&mut self, status: DelegationStatus) {
        self.reserved_upgrade[RESERVED_DELEGATION_STATUS] = status as u8;
    }

    pub fn expected_commit_sequence(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade
                [RESERVED_EXPECTED_COMMIT_SEQUENCE..RESERVED_EXPECTED_COMMIT_SEQUENCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_expected_commit_sequence(&mut self, value: u64) {
        self.reserved_upgrade
            [RESERVED_EXPECTED_COMMIT_SEQUENCE..RESERVED_EXPECTED_COMMIT_SEQUENCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn last_committed_sequence(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade
                [RESERVED_LAST_COMMITTED_SEQUENCE..RESERVED_LAST_COMMITTED_SEQUENCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_last_committed_sequence(&mut self, value: u64) {
        self.reserved_upgrade
            [RESERVED_LAST_COMMITTED_SEQUENCE..RESERVED_LAST_COMMITTED_SEQUENCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn validator(&self) -> [u8; 32] {
        self.reserved_upgrade[RESERVED_VALIDATOR..RESERVED_VALIDATOR + 32]
            .try_into()
            .unwrap()
    }

    pub fn set_validator(&mut self, value: [u8; 32]) {
        self.reserved_upgrade[RESERVED_VALIDATOR..RESERVED_VALIDATOR + 32].copy_from_slice(&value);
    }

    pub fn delegation_sequence(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade[RESERVED_DELEGATION_SEQUENCE..RESERVED_DELEGATION_SEQUENCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_delegation_sequence(&mut self, value: u64) {
        self.reserved_upgrade[RESERVED_DELEGATION_SEQUENCE..RESERVED_DELEGATION_SEQUENCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn commit_interval_ms(&self) -> u32 {
        u32::from_le_bytes(
            self.reserved_upgrade[RESERVED_COMMIT_INTERVAL_MS..RESERVED_COMMIT_INTERVAL_MS + 4]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_commit_interval_ms(&mut self, value: u32) {
        self.reserved_upgrade[RESERVED_COMMIT_INTERVAL_MS..RESERVED_COMMIT_INTERVAL_MS + 4]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn expected_final_commit_sequence(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade[RESERVED_EXPECTED_FINAL_COMMIT_SEQUENCE
                ..RESERVED_EXPECTED_FINAL_COMMIT_SEQUENCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_expected_final_commit_sequence(&mut self, value: u64) {
        self.reserved_upgrade
            [RESERVED_EXPECTED_FINAL_COMMIT_SEQUENCE..RESERVED_EXPECTED_FINAL_COMMIT_SEQUENCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn pending_undelegation(&self) -> bool {
        self.reserved_upgrade[RESERVED_PENDING_UNDELEGATION] != 0
    }

    pub fn set_pending_undelegation(&mut self, value: bool) {
        self.reserved_upgrade[RESERVED_PENDING_UNDELEGATION] = value as u8;
    }

    /// L1 withdrawals and deposits are only safe when the market is not
    /// currently delegated (or has never been / has been fully restored).
    pub fn l1_withdrawals_allowed(&self) -> bool {
        matches!(self.delegation_status(), 0 | 3)
    }

    pub fn protocol_fee_balance(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade[RESERVED_PROTOCOL_FEE_BALANCE..RESERVED_PROTOCOL_FEE_BALANCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_protocol_fee_balance(&mut self, value: u64) {
        self.reserved_upgrade[RESERVED_PROTOCOL_FEE_BALANCE..RESERVED_PROTOCOL_FEE_BALANCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn insurance_fund_balance(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade
                [RESERVED_INSURANCE_FUND_BALANCE..RESERVED_INSURANCE_FUND_BALANCE + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_insurance_fund_balance(&mut self, value: u64) {
        self.reserved_upgrade[RESERVED_INSURANCE_FUND_BALANCE..RESERVED_INSURANCE_FUND_BALANCE + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn recognized_bad_debt(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade[RESERVED_RECOGNIZED_BAD_DEBT..RESERVED_RECOGNIZED_BAD_DEBT + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_recognized_bad_debt(&mut self, value: u64) {
        self.reserved_upgrade[RESERVED_RECOGNIZED_BAD_DEBT..RESERVED_RECOGNIZED_BAD_DEBT + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    pub fn reconciliation_status(&self) -> u8 {
        self.reserved_upgrade[RESERVED_RECONCILIATION_STATUS]
    }

    pub fn set_reconciliation_status(&mut self, status: ReconciliationStatus) {
        self.reserved_upgrade[RESERVED_RECONCILIATION_STATUS] = status as u8;
    }

    pub fn vault_surplus(&self) -> u64 {
        u64::from_le_bytes(
            self.reserved_upgrade[RESERVED_VAULT_SURPLUS..RESERVED_VAULT_SURPLUS + 8]
                .try_into()
                .unwrap(),
        )
    }

    pub fn set_vault_surplus(&mut self, value: u64) {
        self.reserved_upgrade[RESERVED_VAULT_SURPLUS..RESERVED_VAULT_SURPLUS + 8]
            .copy_from_slice(&value.to_le_bytes());
    }

    /// Withdrawals must be blocked while the vault has an unresolved deficit:
    /// paying out against a shortfall the vault cannot cover would only make
    /// the shortfall worse for remaining traders.
    pub fn withdrawals_blocked_by_reconciliation(&self) -> bool {
        matches!(self.reconciliation_status(), 2 | 3)
    }
}

const fn regions_are_disjoint() -> bool {
    BID_ARENA_OFFSET + BID_ARENA_LENGTH <= ASK_ARENA_OFFSET
        && ASK_ARENA_OFFSET + ASK_ARENA_LENGTH <= TRADER_SEAT_OFFSET
        && TRADER_SEAT_OFFSET + TRADER_SEAT_REGION_SIZE <= FILL_EVENT_OFFSET
        && FILL_EVENT_OFFSET + FILL_EVENT_REGION_SIZE == MARKET_ACCOUNT_SIZE
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidationState {
    Healthy = 0,
    Warning = 1,
    Liquidatable = 2,
    Bankrupt = 3,
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct TraderSeat {
    pub occupancy: u8,
    pub trader: [u8; 32],
    pub available_collateral: i128,
    pub reserved_margin: i128,
    pub base_position: i128,
    pub quote_entry_value: i128,
    pub realized_pnl: i128,
    pub last_funding_accumulator: i128,
    pub open_bid_exposure: i128,
    pub open_ask_exposure: i128,
    pub open_order_count: u32,
    pub liquidation_state: u8,
    pub sequence: u64,
    pub reserved: [u8; 66],
}

const _: [(); TRADER_SEAT_SIZE] = [(); size_of::<TraderSeat>()];

impl TraderSeat {
    pub const fn empty() -> Self {
        Self {
            occupancy: 0,
            trader: [0; 32],
            available_collateral: 0,
            reserved_margin: 0,
            base_position: 0,
            quote_entry_value: 0,
            realized_pnl: 0,
            last_funding_accumulator: 0,
            open_bid_exposure: 0,
            open_ask_exposure: 0,
            open_order_count: 0,
            liquidation_state: LiquidationState::Healthy as u8,
            sequence: 0,
            reserved: [0; 66],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.occupancy == 0
    }
    pub fn can_close(&self) -> bool {
        !self.is_empty()
            && self.open_order_count == 0
            && self.base_position == 0
            && self.reserved_margin == 0
            && self.available_collateral >= 0
    }
}

#[repr(C)]
pub struct TraderSeatRegion {
    pub seats: [TraderSeat; MAX_TRADER_SEATS],
}
const _: [(); TRADER_SEAT_REGION_SIZE] = [(); size_of::<TraderSeatRegion>()];

impl TraderSeatRegion {
    pub const fn empty() -> Self {
        Self {
            seats: [TraderSeat::empty(); MAX_TRADER_SEATS],
        }
    }
    pub fn find(&self, trader: &[u8; 32]) -> Option<usize> {
        let mut i = 0;
        while i < MAX_TRADER_SEATS {
            if self.seats[i].occupancy != 0 && self.seats[i].trader == *trader {
                return Some(i);
            }
            i += 1;
        }
        None
    }
    pub fn create(&mut self, trader: [u8; 32]) -> Result<usize, SeatError> {
        if self.find(&trader).is_some() {
            return Err(SeatError::Duplicate);
        }
        let mut i = 0;
        while i < MAX_TRADER_SEATS {
            if self.seats[i].is_empty() {
                let mut seat = TraderSeat::empty();
                seat.occupancy = 1;
                seat.trader = trader;
                seat.sequence = i as u64 + 1;
                self.seats[i] = seat;
                return Ok(i);
            }
            i += 1;
        }
        Err(SeatError::Full)
    }
    pub fn close(&mut self, index: usize) -> Result<(), SeatError> {
        if index >= MAX_TRADER_SEATS {
            return Err(SeatError::Invalid);
        }
        if !self.seats[index].is_empty() && self.seats[index].can_close() {
            self.seats[index] = TraderSeat::empty();
            Ok(())
        } else {
            Err(SeatError::NotEmpty)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeatError {
    Invalid,
    Duplicate,
    Full,
    NotEmpty,
}
