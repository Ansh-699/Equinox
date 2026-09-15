use pinocchio::error::ProgramError;

pub const INITIALIZE_MARKET_DISCRIMINATOR: u8 = 0;

pub enum StockStreamInstruction {
    InitializeMarket,
}

impl StockStreamInstruction {
    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        match data {
            [INITIALIZE_MARKET_DISCRIMINATOR] => Ok(Self::InitializeMarket),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
