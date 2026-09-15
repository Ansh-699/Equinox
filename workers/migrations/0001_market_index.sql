CREATE TABLE IF NOT EXISTS markets (
  symbol TEXT PRIMARY KEY,
  market_index INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  oracle_feed_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot INTEGER,
  payload TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  FOREIGN KEY (symbol) REFERENCES markets(symbol)
);

CREATE INDEX IF NOT EXISTS market_events_symbol_observed_at
  ON market_events(symbol, observed_at DESC);

CREATE TABLE IF NOT EXISTS application_sessions (
  id_hash TEXT PRIMARY KEY,
  privy_user_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS application_sessions_expiry ON application_sessions(expires_at);

CREATE TABLE IF NOT EXISTS launch_pools (
  id TEXT PRIMARY KEY,
  stock_symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  pool_address TEXT NOT NULL UNIQUE,
  quote_mint TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS launch_pools_stock_symbol
  ON launch_pools(stock_symbol, updated_at DESC);
