# Equinox Market Registry

Equinox derives each instrument and perpetual market from stable identifiers.
The program registry uses `instrument` plus a 32-byte instrument ID for the
instrument PDA, and `perp-market` plus the instrument PDA for the market PDA.
Each market then owns its order-book account, vault configuration, oracle
configuration, session policy and MagicBlock delegation state. Settlement
scratch accounts remain derived from `settlement`, market address and the
little-endian seat index.

The repository includes AAPL-PERP, TSLA-PERP and NVDA-PERP fixtures. They are
explicitly `live: false` until their mint, Pyth Pro feed, session policy and
deployment addresses are independently verified. AAPL is the first demo
fixture, not a protocol-wide special case.

The Rust program exposes `InitializeExchange`, `RegisterStockInstrument` and
`CreatePerpMarket` dispatch variants with fixed 128-byte exchange and
instrument layouts. The client exposes matching constructors and the worker
registry stores the instrument ID, market PDA, vault PDA and session policy.
