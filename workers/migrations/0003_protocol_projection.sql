CREATE TABLE IF NOT EXISTS stock_instruments (
  instrument_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  feed_id TEXT NOT NULL,
  oracle_channel TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS perp_markets (
  market_pda TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  vault_pda TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  er_sequence INTEGER NOT NULL DEFAULT 0,
  l1_commit_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  market_pda TEXT NOT NULL,
  domain TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (market_pda, domain)
);

CREATE TABLE IF NOT EXISTS indexed_events (
  event_id TEXT PRIMARY KEY,
  market_pda TEXT NOT NULL,
  domain TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oracle_updates (
  market_pda TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (market_pda, timestamp)
);

CREATE TABLE IF NOT EXISTS commit_records (
  market_pda TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (market_pda, sequence)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  market_pda TEXT NOT NULL,
  domain TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (market_pda, domain)
);

CREATE TABLE IF NOT EXISTS keeper_leases (
  lease_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
