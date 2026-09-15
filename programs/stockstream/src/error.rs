use pinocchio::error::ProgramError;

#[repr(u32)]
pub enum StockStreamError {
    MarketNotWritable = 0x6000,
    InvalidMarketLayout = 0x6001,
    MarketAlreadyInitialized = 0x6002,
    MarketNotInitialized = 0x6003,
    OracleUnavailable = 0x6004,
    InvalidInstruction = 0x6005,
    InvalidSeat = 0x6006,
    SeatOccupied = 0x6007,
    SeatsFull = 0x6008,
    SeatNotEmpty = 0x6009,
    RiskViolation = 0x600A,
    ArithmeticOverflow = 0x600B,
    UnsupportedInProduction = 0x600C,
}

impl From<StockStreamError> for ProgramError {
    fn from(error: StockStreamError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
