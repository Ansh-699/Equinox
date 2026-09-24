//! StockStream market maker: an always-on devnet quoting bot for the V3
//! TSLA-PERP book inside the MagicBlock rollup, meant for a small VM placed
//! next to the rollup validator (devnet-as is in Singapore).

pub mod candles;
pub mod keeper;
pub mod maker;
pub mod quotes;
pub mod reporter;
pub mod rpc;
pub mod solana;
pub mod v3;
