use pinocchio::error::ProgramError;

pub const INITIALIZE_MARKET: u8 = 0;
pub const INITIALIZE_MARKET_DISCRIMINATOR: u8 = INITIALIZE_MARKET;
pub const CREATE_TRADER_SEAT: u8 = 1;
pub const CLOSE_TRADER_SEAT: u8 = 2;
pub const PLACE_ORDER: u8 = 3;
pub const CANCEL_ORDER: u8 = 4;
pub const CANCEL_ALL: u8 = 5;
pub const UPDATE_FUNDING: u8 = 6;
pub const LIQUIDATE: u8 = 7;
pub const INITIALIZE_SETTLEMENT_SCRATCH: u8 = 8;
pub const INITIALIZE_VAULT: u8 = 9;
pub const DEPOSIT_COLLATERAL: u8 = 10;
pub const WITHDRAW_COLLATERAL: u8 = 11;
pub const CONSUME_ORACLE_UPDATE: u8 = 12;
pub const DELEGATE_MARKET: u8 = 13;
pub const DELEGATE_CLUSTER_MEMBER: u8 = 41;
/// Creates the perp-market PDA account itself via a real system
/// `create_account` CPI signed by the market PDA's seeds: a PDA cannot sign
/// a client transaction, so without this helper NO perp market can be
/// created on L1 (deployment gap, mirrors `delegate_market`'s own buffer
/// creation pattern).
pub const CREATE_MARKET_ACCOUNT: u8 = 42;
pub const CREATE_INSTRUMENT_ACCOUNT: u8 = 43;
pub const CREATE_VAULT_ACCOUNT: u8 = 44;
pub const CREATE_SCRATCH_ACCOUNT: u8 = 45;
/// Creates (or grows) one bounded, independently-committable V3 account.
/// Data: `[46, kind:u8, index:u8]`; see `v3::V3AccountKind`.
pub const CREATE_V3_ACCOUNT: u8 = 46;
/// Governance-authorized activation for a structurally created V3 core.
pub const INITIALIZE_V3_MARKET: u8 = 47;
/// Delegates one V3 core/page/shard to the core's selected ER validator.
/// Data: `[48, kind:u8, index:u8, validator:Pubkey]`.
pub const DELEGATE_V3_ACCOUNT: u8 = 48;
/// Creates one 256-byte trader seat inside its V3 seat shard. Data:
/// `[49, seat_index:u16]`.
pub const CREATE_V3_TRADER_SEAT: u8 = 49;
/// Closes an empty V3 trader seat. Data: `[50, seat_index:u16]`.
pub const CLOSE_V3_TRADER_SEAT: u8 = 50;
/// Owner-program recovery request for a V3 core whose validator undelegation
/// callback has timed out. Data is `[51]`; the owner may then use `[52]` after
/// the request expiry to roll back safely through the delegation program.
pub const REQUEST_V3_UNDELEGATION: u8 = 51;
pub const ROLLBACK_V3_UNDELEGATION: u8 = 52;
/// L1 custody against the sharded V3 state. Deposit uses one seat shard and
/// the four event shards; withdrawal additionally requires the complete
/// execution bundle so restoration/finality cannot be bypassed.
pub const DEPOSIT_COLLATERAL_V3: u8 = 53;
pub const WITHDRAW_COLLATERAL_V3: u8 = 54;
pub const COMMIT_MARKET: u8 = 14;
pub const COMMIT_AND_UNDELEGATE: u8 = 15;
/// Reserved: the real external-undelegate callback uses the delegation
/// program's own fixed 8-byte discriminator
/// (`magicblock::EXTERNAL_UNDELEGATE_DISCRIMINATOR`), routed in
/// `lib.rs::process_instruction` before this single-byte tag dispatch is
/// ever reached. This opcode is not reused for anything else.
pub const UNDELEGATION_CALLBACK_RESERVED: u8 = 16;
pub const AUTHORIZE_TRADING_SESSION: u8 = 17;
pub const REVOKE_TRADING_SESSION: u8 = 18;
pub const INITIALIZE_EXCHANGE: u8 = 19;
pub const REGISTER_STOCK_INSTRUMENT: u8 = 20;
pub const CREATE_PERP_MARKET: u8 = 21;
pub const UPDATE_STOCK_INSTRUMENT: u8 = 22;
pub const SUSPEND_STOCK_INSTRUMENT: u8 = 23;
pub const UPDATE_MARKET_RISK: u8 = 24;
pub const PAUSE_MARKET: u8 = 25;
pub const RESUME_MARKET: u8 = 26;
pub const SET_CLOSE_ONLY: u8 = 27;
pub const ENTER_CORPORATE_ACTION: u8 = 28;
pub const RESOLVE_CORPORATE_ACTION: u8 = 29;
pub const CLOSE_MARKET: u8 = 30;
pub const UPDATE_TRADING_SESSION_LIMITS: u8 = 31;
pub const CLOSE_TRADING_SESSION: u8 = 32;
pub const REPLACE_ORDER: u8 = 33;
pub const TRANSFER_TO_INSURANCE_FUND: u8 = 34;
pub const WITHDRAW_PROTOCOL_FEES: u8 = 35;
pub const WITHDRAW_INSURANCE_FUNDS: u8 = 36;
pub const RECORD_BAD_DEBT: u8 = 37;
pub const RESOLVE_BAD_DEBT: u8 = 38;
pub const RECONCILE_VAULT: u8 = 39;
pub const UPDATE_EXCHANGE_CONFIG: u8 = 40;

/// One bit per `UpdateExchangeConfig` field. A field is applied only when
/// its bit is set in the instruction's `field_mask`; every other field in
/// the fixed-layout payload is present on the wire (so the encoding is
/// never ambiguous-length) but ignored. `authority` (the exchange's
/// listing identity) and `instrument_count` (a derived counter) have no
/// bit at all -- they are not updatable through this instruction by
/// construction, not merely by convention.
pub mod exchange_config_field {
    pub const PAUSE_AUTHORITY: u32 = 1 << 0;
    pub const EMERGENCY_AUTHORITY: u32 = 1 << 1;
    pub const KEEPER_AUTHORITY: u32 = 1 << 2;
    pub const MAKER_FEE_BPS: u32 = 1 << 3;
    pub const TAKER_FEE_BPS: u32 = 1 << 4;
    pub const LIQUIDATION_FEE_BPS: u32 = 1 << 5;
    pub const DEFAULT_INITIAL_MARGIN_BPS: u32 = 1 << 6;
    pub const DEFAULT_MAINTENANCE_MARGIN_BPS: u32 = 1 << 7;
    pub const DEFAULT_MAXIMUM_LEVERAGE: u32 = 1 << 8;
    pub const COLLATERAL_MINT: u32 = 1 << 9;
    pub const ORACLE_PROGRAM: u32 = 1 << 10;
    pub const INSURANCE_TARGET_BALANCE: u32 = 1 << 11;
    pub const PROTOCOL_STATUS: u32 = 1 << 12;
    /// Bits beyond this are reserved for future fields; a caller setting
    /// one today is almost certainly a bug (a client built against a
    /// newer field than this program version understands), so `decode`
    /// rejects it outright rather than silently ignoring it.
    pub const ALL_KNOWN: u32 = (1 << 13) - 1;
}

#[derive(Clone, Copy)]
pub struct PlaceOrderData {
    pub side: u8,
    pub tree: u8,
    pub flags: u8,
    pub seat_index: u16,
    pub quantity: u64,
    pub price_or_offset: i64,
    pub expires_at: u64,
    pub peg_limit: i64,
    pub client_order_id: u64,
    /// Strictly monotonic scoped-session action nonce. Main-wallet actions
    /// encode zero and do not consume a session nonce.
    pub action_nonce: u64,
}

/// The distinct semantic reason for a `TransitionMarket` instruction,
/// preserved alongside the resulting `mode` so a handler can emit the
/// correct event even when two opcodes resolve to the same `mode`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum MarketTransitionAction {
    Pause = 0,
    Resume = 1,
    SetCloseOnly = 2,
    EnterCorporateAction = 3,
    ResolveCorporateAction = 4,
    Close = 5,
}

pub enum StockStreamInstruction {
    InitializeMarket,
    CreateTraderSeat {
        seat_index: u16,
    },
    CloseTraderSeat {
        seat_index: u16,
    },
    PlaceOrder(PlaceOrderData),
    CancelOrder {
        seat_index: u16,
        order_key: u128,
        action_nonce: u64,
    },
    CancelAll {
        seat_index: u16,
        max_cancellations: u8,
        action_nonce: u64,
    },
    UpdateFunding {
        accumulator: i128,
        timestamp: u64,
    },
    Liquidate {
        seat_index: u16,
        max_quantity: u64,
    },
    InitializeSettlementScratch {
        seat_index: u16,
    },
    InitializeVault,
    DepositCollateral {
        seat_index: u16,
        amount: u64,
    },
    WithdrawCollateral {
        seat_index: u16,
        amount: u64,
    },
    ConsumeOracleUpdate,
    DelegateMarket {
        validator: [u8; 32],
    },
    /// Delegates ONE hot-cluster member (a settlement-scratch or
    /// `TradingSession` PDA) to the market's validator. See
    /// `magicblock::delegate_cluster_member`.
    DelegateClusterMember {
        validator: [u8; 32],
    },
    /// CPI-creates the perp-market PDA account (payer-funded, program-owned,
    /// `MARKET_ACCOUNT_SIZE` bytes). See `registry::create_market_account`.
    CreateMarketAccount,
    /// CPI-creates the stock-instrument PDA (128 bytes). See
    /// `registry::create_instrument_account`.
    CreateInstrumentAccount {
        instrument_id: [u8; 32],
    },
    /// CPI-creates the vault SPL token account and configures the header.
    /// See `registry::create_vault_account`.
    CreateVaultAccount,
    /// CPI-creates the settlement-scratch PDA account. Data: [45, seat:u16].
    /// See `registry::create_scratch_account`.
    CreateScratchAccount {
        seat_index: u16,
    },
    /// Creates one V3 core/page/shard PDA. This is intentionally separate
    /// from V2 market creation; a V3 account can never alias the monolith.
    CreateV3Account {
        kind: u8,
        index: u8,
    },
    /// Binds a V3 core to the exchange listing authority. Structural account
    /// creation is permissionless; activation is not.
    InitializeV3Market,
    DelegateV3Account {
        kind: u8,
        index: u8,
        validator: [u8; 32],
    },
    CreateV3TraderSeat {
        seat_index: u16,
    },
    CloseV3TraderSeat {
        seat_index: u16,
    },
    RequestV3Undelegation,
    RollbackV3Undelegation,
    DepositCollateralV3 {
        seat_index: u16,
        amount: u64,
    },
    WithdrawCollateralV3 {
        seat_index: u16,
        amount: u64,
    },
    CommitMarket {
        sequence: u64,
    },
    CommitAndUndelegate {
        sequence: u64,
    },
    AuthorizeTradingSession {
        seat_index: u16,
        expires_at: u64,
        actions: u8,
        max_order_notional: u64,
        max_cumulative_notional: u64,
        maximum_exposure: i128,
        maximum_open_orders: u16,
    },
    RevokeTradingSession {
        seat_index: u16,
    },
    UpdateTradingSessionLimits {
        seat_index: u16,
        expires_at: u64,
        actions: u8,
        max_order_notional: u64,
        max_cumulative_notional: u64,
        maximum_exposure: i128,
        maximum_open_orders: u16,
    },
    CloseTradingSession {
        seat_index: u16,
    },
    /// The new order's `seat_index` also identifies the seat the old order
    /// (identified by `old_order_key`) must belong to -- there is no
    /// separate outer seat index since a replacement can never move an
    /// order to a different seat.
    ReplaceOrder {
        old_order_key: u128,
        new_order: PlaceOrderData,
    },
    InitializeExchange,
    RegisterStockInstrument {
        instrument_id: [u8; 32],
    },
    CreatePerpMarket {
        instrument_id: [u8; 32],
    },
    UpdateStockInstrument {
        instrument_id: [u8; 32],
        pyth_feed_id: u32,
        oracle_channel: u8,
        price_exponent: i32,
    },
    SuspendStockInstrument {
        instrument_id: [u8; 32],
    },
    UpdateMarketRisk {
        initial_margin_bps: u16,
        maintenance_margin_bps: u16,
        maximum_leverage: u32,
    },
    TransitionMarket {
        mode: u8,
        /// The specific opcode that produced this transition. Several of
        /// the six `TransitionMarket`-shaped opcodes resolve to the same
        /// `mode` (`PAUSE_MARKET`/`CLOSE_MARKET` both mean `Paused`;
        /// `RESUME_MARKET`/`RESOLVE_CORPORATE_ACTION` both mean `Open`) --
        /// `mode` alone is not enough to tell them apart, which used to
        /// make it impossible for `transition_market` to emit the correct
        /// distinct event (e.g. `MarketClosed` vs `MarketPaused`). Every
        /// opcode is on the wire as its own distinct byte already; this
        /// field just carries that same distinction forward into the
        /// decoded instruction instead of discarding it.
        action: MarketTransitionAction,
    },
    /// Moves `amount` from the protocol fee ledger to the insurance fund
    /// ledger. Internal book-transfer only: no tokens move (both balances
    /// are backed by the same vault).
    TransferToInsuranceFund {
        amount: u64,
    },
    /// Pays `amount` out of the protocol fee ledger to `destination` via a
    /// real vault-authority-signed SPL transfer.
    WithdrawProtocolFees {
        amount: u64,
    },
    /// Pays `amount` out of the insurance fund ledger to `destination` via a
    /// real vault-authority-signed SPL transfer. Emergency-authority only.
    WithdrawInsuranceFunds {
        amount: u64,
    },
    /// Formally recognizes `amount` of a bankrupt seat's negative equity as
    /// unrecoverable bad debt, forgiving that much of the seat's negative
    /// `realized_pnl`. Emergency-authority only.
    RecordBadDebt {
        seat_index: u16,
        amount: u64,
    },
    /// Pays down `amount` of recognized bad debt from the insurance fund
    /// ledger. Emergency-authority only.
    ResolveBadDebt {
        amount: u64,
    },
    /// Recomputes the vault's actual token balance against the sum of every
    /// seat's `available_collateral` plus the fee/insurance ledgers minus
    /// recognized bad debt, and records the result.
    ReconcileVault,
    UpdateExchangeConfig {
        field_mask: u32,
        pause_authority: [u8; 32],
        emergency_authority: [u8; 32],
        keeper_authority: [u8; 32],
        maker_fee_bps: u16,
        taker_fee_bps: u16,
        liquidation_fee_bps: u16,
        default_initial_margin_bps: u16,
        default_maintenance_margin_bps: u16,
        default_maximum_leverage: u32,
        collateral_mint: [u8; 32],
        oracle_program: [u8; 32],
        insurance_target_balance: u64,
        protocol_status: u8,
        /// Rejected unless it equals the exchange account's current
        /// `config_sequence` -- a stale read-modify-write race against a
        /// concurrent update is rejected rather than silently
        /// overwriting it.
        expected_config_sequence: u64,
    },
}

fn read_u16(data: &[u8], start: usize) -> Option<u16> {
    data.get(start..start + 2)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
}
fn read_u64(data: &[u8], start: usize) -> Option<u64> {
    data.get(start..start + 8)
        .and_then(|v| <[u8; 8]>::try_from(v).ok())
        .map(u64::from_le_bytes)
}
fn read_i64(data: &[u8], start: usize) -> Option<i64> {
    read_u64(data, start).map(|v| v as i64)
}
fn read_u128(data: &[u8], start: usize) -> Option<u128> {
    data.get(start..start + 16)
        .and_then(|v| <[u8; 16]>::try_from(v).ok())
        .map(u128::from_le_bytes)
}
fn read_i128(data: &[u8], start: usize) -> Option<i128> {
    read_u128(data, start).map(|v| v as i128)
}

impl StockStreamInstruction {
    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        match data.first().copied() {
            Some(INITIALIZE_MARKET) if data.len() == 1 => Ok(Self::InitializeMarket),
            Some(CREATE_TRADER_SEAT) if data.len() == 3 => Ok(Self::CreateTraderSeat {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CLOSE_TRADER_SEAT) if data.len() == 3 => Ok(Self::CloseTraderSeat {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(PLACE_ORDER) if data.len() == 54 => Ok(Self::PlaceOrder(PlaceOrderData {
                side: data[1],
                tree: data[2],
                flags: data[3],
                seat_index: read_u16(data, 4).ok_or(ProgramError::InvalidInstructionData)?,
                quantity: read_u64(data, 6).ok_or(ProgramError::InvalidInstructionData)?,
                price_or_offset: read_i64(data, 14).ok_or(ProgramError::InvalidInstructionData)?,
                expires_at: read_u64(data, 22).ok_or(ProgramError::InvalidInstructionData)?,
                peg_limit: read_i64(data, 30).ok_or(ProgramError::InvalidInstructionData)?,
                client_order_id: read_u64(data, 38).ok_or(ProgramError::InvalidInstructionData)?,
                action_nonce: read_u64(data, 46).ok_or(ProgramError::InvalidInstructionData)?,
            })),
            Some(CANCEL_ORDER) if data.len() == 27 => Ok(Self::CancelOrder {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                order_key: read_u128(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
                action_nonce: read_u64(data, 19).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CANCEL_ALL) if data.len() == 12 => Ok(Self::CancelAll {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                max_cancellations: data[3],
                action_nonce: read_u64(data, 4).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(UPDATE_FUNDING) if data.len() == 25 => Ok(Self::UpdateFunding {
                accumulator: read_i128(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                timestamp: read_u64(data, 17).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(LIQUIDATE) if data.len() == 11 => Ok(Self::Liquidate {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                max_quantity: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(INITIALIZE_SETTLEMENT_SCRATCH) if data.len() == 3 => {
                Ok(Self::InitializeSettlementScratch {
                    seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(INITIALIZE_VAULT) if data.len() == 1 => Ok(Self::InitializeVault),
            Some(DEPOSIT_COLLATERAL) if data.len() == 11 => Ok(Self::DepositCollateral {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                amount: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(WITHDRAW_COLLATERAL) if data.len() == 11 => Ok(Self::WithdrawCollateral {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                amount: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CONSUME_ORACLE_UPDATE) if (107..=516).contains(&data.len()) => {
                Ok(Self::ConsumeOracleUpdate)
            }
            Some(DELEGATE_MARKET) if data.len() == 33 => Ok(Self::DelegateMarket {
                validator: data[1..33]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            }),
            Some(DELEGATE_CLUSTER_MEMBER) if data.len() == 33 => Ok(Self::DelegateClusterMember {
                validator: data[1..33]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            }),
            Some(CREATE_MARKET_ACCOUNT) if data.len() == 1 => Ok(Self::CreateMarketAccount),
            Some(CREATE_VAULT_ACCOUNT) if data.len() == 1 => Ok(Self::CreateVaultAccount),
            Some(CREATE_SCRATCH_ACCOUNT) if data.len() == 3 => Ok(Self::CreateScratchAccount {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CREATE_V3_ACCOUNT)
                if data.len() == 3
                    && crate::v3::V3AccountKind::from_u8(data[1])
                        .filter(|kind| data[2] <= kind.max_index())
                        .is_some() =>
            {
                Ok(Self::CreateV3Account {
                    kind: data[1],
                    index: data[2],
                })
            }
            Some(INITIALIZE_V3_MARKET) if data.len() == 1 => Ok(Self::InitializeV3Market),
            Some(DELEGATE_V3_ACCOUNT)
                if data.len() == 35
                    && crate::v3::V3AccountKind::from_u8(data[1])
                        .filter(|kind| data[2] <= kind.max_index())
                        .is_some() =>
            {
                Ok(Self::DelegateV3Account {
                    kind: data[1],
                    index: data[2],
                    validator: data[3..35]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                })
            }
            Some(CREATE_INSTRUMENT_ACCOUNT) if data.len() == 33 => {
                Ok(Self::CreateInstrumentAccount {
                    instrument_id: data[1..33]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                })
            }
            Some(COMMIT_MARKET) if data.len() == 9 => Ok(Self::CommitMarket {
                sequence: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CREATE_V3_TRADER_SEAT) if data.len() == 3 => Ok(Self::CreateV3TraderSeat {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(DEPOSIT_COLLATERAL_V3) if data.len() == 11 => Ok(Self::DepositCollateralV3 {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                amount: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(WITHDRAW_COLLATERAL_V3) if data.len() == 11 => Ok(Self::WithdrawCollateralV3 {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                amount: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CLOSE_V3_TRADER_SEAT) if data.len() == 3 => Ok(Self::CloseV3TraderSeat {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(REQUEST_V3_UNDELEGATION) if data.len() == 1 => Ok(Self::RequestV3Undelegation),
            Some(ROLLBACK_V3_UNDELEGATION) if data.len() == 1 => Ok(Self::RollbackV3Undelegation),
            Some(COMMIT_AND_UNDELEGATE) if data.len() == 9 => Ok(Self::CommitAndUndelegate {
                sequence: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(AUTHORIZE_TRADING_SESSION) if data.len() == 46 => {
                Ok(Self::AuthorizeTradingSession {
                    seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                    expires_at: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
                    actions: data[11],
                    max_order_notional: read_u64(data, 12)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    max_cumulative_notional: read_u64(data, 20)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    maximum_exposure: read_i128(data, 28)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    maximum_open_orders: read_u16(data, 44)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(REVOKE_TRADING_SESSION) if data.len() == 3 => Ok(Self::RevokeTradingSession {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(UPDATE_TRADING_SESSION_LIMITS) if data.len() == 46 => {
                Ok(Self::UpdateTradingSessionLimits {
                    seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                    expires_at: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
                    actions: data[11],
                    max_order_notional: read_u64(data, 12)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    max_cumulative_notional: read_u64(data, 20)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    maximum_exposure: read_i128(data, 28)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    maximum_open_orders: read_u16(data, 44)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(CLOSE_TRADING_SESSION) if data.len() == 3 => Ok(Self::CloseTradingSession {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(REPLACE_ORDER) if data.len() == 70 => Ok(Self::ReplaceOrder {
                old_order_key: read_u128(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                new_order: PlaceOrderData {
                    side: data[17],
                    tree: data[18],
                    flags: data[19],
                    seat_index: read_u16(data, 20).ok_or(ProgramError::InvalidInstructionData)?,
                    quantity: read_u64(data, 22).ok_or(ProgramError::InvalidInstructionData)?,
                    price_or_offset: read_i64(data, 30)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    expires_at: read_u64(data, 38).ok_or(ProgramError::InvalidInstructionData)?,
                    peg_limit: read_i64(data, 46).ok_or(ProgramError::InvalidInstructionData)?,
                    client_order_id: read_u64(data, 54)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    action_nonce: read_u64(data, 62).ok_or(ProgramError::InvalidInstructionData)?,
                },
            }),
            Some(INITIALIZE_EXCHANGE) if data.len() == 1 => Ok(Self::InitializeExchange),
            Some(REGISTER_STOCK_INSTRUMENT) if data.len() == 33 => {
                Ok(Self::RegisterStockInstrument {
                    instrument_id: data[1..33]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                })
            }
            Some(CREATE_PERP_MARKET) if data.len() == 33 => Ok(Self::CreatePerpMarket {
                instrument_id: data[1..33]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            }),
            Some(UPDATE_STOCK_INSTRUMENT) if data.len() == 42 => Ok(Self::UpdateStockInstrument {
                instrument_id: data[1..33]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
                pyth_feed_id: read_u32(data, 33).ok_or(ProgramError::InvalidInstructionData)?,
                oracle_channel: data[37],
                price_exponent: read_i32(data, 38).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(SUSPEND_STOCK_INSTRUMENT) if data.len() == 33 => {
                Ok(Self::SuspendStockInstrument {
                    instrument_id: data[1..33]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                })
            }
            Some(UPDATE_MARKET_RISK) if data.len() == 9 => Ok(Self::UpdateMarketRisk {
                initial_margin_bps: read_u16(data, 1)
                    .ok_or(ProgramError::InvalidInstructionData)?,
                maintenance_margin_bps: read_u16(data, 3)
                    .ok_or(ProgramError::InvalidInstructionData)?,
                maximum_leverage: read_u32(data, 5).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(PAUSE_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 0,
                action: MarketTransitionAction::Pause,
            }),
            Some(RESUME_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 1,
                action: MarketTransitionAction::Resume,
            }),
            Some(SET_CLOSE_ONLY) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 2,
                action: MarketTransitionAction::SetCloseOnly,
            }),
            Some(ENTER_CORPORATE_ACTION) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 3,
                action: MarketTransitionAction::EnterCorporateAction,
            }),
            Some(RESOLVE_CORPORATE_ACTION) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 1,
                action: MarketTransitionAction::ResolveCorporateAction,
            }),
            Some(CLOSE_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket {
                mode: 0,
                action: MarketTransitionAction::Close,
            }),
            Some(TRANSFER_TO_INSURANCE_FUND) if data.len() == 9 => {
                Ok(Self::TransferToInsuranceFund {
                    amount: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(WITHDRAW_PROTOCOL_FEES) if data.len() == 9 => Ok(Self::WithdrawProtocolFees {
                amount: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(WITHDRAW_INSURANCE_FUNDS) if data.len() == 9 => Ok(Self::WithdrawInsuranceFunds {
                amount: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(RECORD_BAD_DEBT) if data.len() == 11 => Ok(Self::RecordBadDebt {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                amount: read_u64(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(RESOLVE_BAD_DEBT) if data.len() == 9 => Ok(Self::ResolveBadDebt {
                amount: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(RECONCILE_VAULT) if data.len() == 1 => Ok(Self::ReconcileVault),
            Some(UPDATE_EXCHANGE_CONFIG) if data.len() == 196 => {
                let field_mask = read_u32(data, 1).ok_or(ProgramError::InvalidInstructionData)?;
                if field_mask & !exchange_config_field::ALL_KNOWN != 0 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Self::UpdateExchangeConfig {
                    field_mask,
                    pause_authority: data[5..37]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                    emergency_authority: data[37..69]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                    keeper_authority: data[69..101]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                    maker_fee_bps: read_u16(data, 101)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    taker_fee_bps: read_u16(data, 103)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    liquidation_fee_bps: read_u16(data, 105)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    default_initial_margin_bps: read_u16(data, 107)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    default_maintenance_margin_bps: read_u16(data, 109)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    default_maximum_leverage: read_u32(data, 111)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    collateral_mint: data[115..147]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                    oracle_program: data[147..179]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                    insurance_target_balance: read_u64(data, 179)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                    protocol_status: data[187],
                    expected_config_sequence: read_u64(data, 188)
                        .ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

fn read_u32(data: &[u8], start: usize) -> Option<u32> {
    data.get(start..start + 4)
        .and_then(|v| <[u8; 4]>::try_from(v).ok())
        .map(u32::from_le_bytes)
}
fn read_i32(data: &[u8], start: usize) -> Option<i32> {
    read_u32(data, start).map(|v| v as i32)
}
