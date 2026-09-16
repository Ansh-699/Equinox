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
pub const COMMIT_MARKET: u8 = 14;
pub const COMMIT_AND_UNDELEGATE: u8 = 15;
pub const UNDELEGATION_CALLBACK: u8 = 16;
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
    },
    CancelAll {
        seat_index: u16,
        max_cancellations: u8,
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
        sequence: u64,
    },
    CommitMarket {
        sequence: u64,
    },
    CommitAndUndelegate {
        sequence: u64,
    },
    UndelegationCallback {
        sequence: u64,
    },
    AuthorizeTradingSession {
        expires_at: u64,
        nonce: u64,
    },
    RevokeTradingSession {
        nonce: u64,
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
            Some(PLACE_ORDER) if data.len() == 46 => Ok(Self::PlaceOrder(PlaceOrderData {
                side: data[1],
                tree: data[2],
                flags: data[3],
                seat_index: read_u16(data, 4).ok_or(ProgramError::InvalidInstructionData)?,
                quantity: read_u64(data, 6).ok_or(ProgramError::InvalidInstructionData)?,
                price_or_offset: read_i64(data, 14).ok_or(ProgramError::InvalidInstructionData)?,
                expires_at: read_u64(data, 22).ok_or(ProgramError::InvalidInstructionData)?,
                peg_limit: read_i64(data, 30).ok_or(ProgramError::InvalidInstructionData)?,
                client_order_id: read_u64(data, 38).ok_or(ProgramError::InvalidInstructionData)?,
            })),
            Some(CANCEL_ORDER) if data.len() == 19 => Ok(Self::CancelOrder {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                order_key: read_u128(data, 3).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(CANCEL_ALL) if data.len() == 4 => Ok(Self::CancelAll {
                seat_index: read_u16(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                max_cancellations: data[3],
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
            Some(CONSUME_ORACLE_UPDATE) if (104..=513).contains(&data.len()) => {
                Ok(Self::ConsumeOracleUpdate)
            }
            Some(DELEGATE_MARKET) if data.len() == 9 => Ok(Self::DelegateMarket {
                sequence: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(COMMIT_MARKET) if data.len() == 9 => Ok(Self::CommitMarket {
                sequence: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(COMMIT_AND_UNDELEGATE) if data.len() == 9 => Ok(Self::CommitAndUndelegate {
                sequence: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
            }),
            Some(UNDELEGATION_CALLBACK)
                if data.len() == 17 && data[1..9] == [196, 28, 41, 206, 48, 37, 51, 167] =>
            {
                Ok(Self::UndelegationCallback {
                    sequence: read_u64(data, 9).ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(AUTHORIZE_TRADING_SESSION) if data.len() == 17 => {
                Ok(Self::AuthorizeTradingSession {
                    expires_at: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
                    nonce: read_u64(data, 9).ok_or(ProgramError::InvalidInstructionData)?,
                })
            }
            Some(REVOKE_TRADING_SESSION) if data.len() == 9 => Ok(Self::RevokeTradingSession {
                nonce: read_u64(data, 1).ok_or(ProgramError::InvalidInstructionData)?,
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
            Some(PAUSE_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket { mode: 0 }),
            Some(RESUME_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket { mode: 1 }),
            Some(SET_CLOSE_ONLY) if data.len() == 1 => Ok(Self::TransitionMarket { mode: 2 }),
            Some(ENTER_CORPORATE_ACTION) if data.len() == 1 => {
                Ok(Self::TransitionMarket { mode: 3 })
            }
            Some(RESOLVE_CORPORATE_ACTION) if data.len() == 1 => {
                Ok(Self::TransitionMarket { mode: 1 })
            }
            Some(CLOSE_MARKET) if data.len() == 1 => Ok(Self::TransitionMarket { mode: 0 }),
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
