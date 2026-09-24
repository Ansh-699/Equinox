-- Meteora DBC launches made through StockStream (display registry; the chain is the truth).
CREATE TABLE IF NOT EXISTS launches (
  pool TEXT PRIMARY KEY,
  base_mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_created ON launches (created_at DESC);
