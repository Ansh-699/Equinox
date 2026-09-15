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
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
