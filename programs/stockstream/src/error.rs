use pinocchio::error::ProgramError;

#[repr(u32)]
pub enum StockStreamError {
    MarketNotWritable = 0x6000,
}

impl From<StockStreamError> for ProgramError {
    fn from(error: StockStreamError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
