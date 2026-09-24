# Build Context

**Project:** Equinox

**Architecture:** Pinocchio Solana perpetuals CLOB with a capped delegated
TradingCredit PDA for MagicBlock ER matching. Collateral, free margin,
positions, funding and liquidations remain L1. Cloudflare Workers indexes
verified events into D1 and fans out market-specific streams through Durable
Objects. Privy embedded wallets sign user-authorized transactions; browser
code never receives Pyth Pro credentials or keeper ingestion secrets.

**Current work:** Preserve the imported SlipStream baseline while migrating a
new Equinox program to Pinocchio 0.11.2. Add backend ingestion and stream
services before adapting the frontend away from simulation state.
