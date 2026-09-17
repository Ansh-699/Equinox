-- Priority 8: durable transaction-attempt records for every keeper job
-- (Pyth, MagicBlock commit, funding, market session, expiry cleanup,
-- liquidation), and a durable continuation cursor for the expiry-cleanup
-- keeper's bounded sweeps. `oracle_updates`/`commit_records`
-- (0003_protocol_projection.sql) already exist for their own keepers and
-- are wired up alongside this table, not replaced by it.
CREATE TABLE tx_attempts (
  id TEXT PRIMARY KEY,
  keeper TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('l1', 'er')),
  signature TEXT,
  status TEXT NOT NULL CHECK(status IN ('submitted', 'confirmed', 'finalized', 'failed', 'expired', 'timeout')),
  error TEXT,
  submitted_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX tx_attempts_market ON tx_attempts(market_pda, keeper);

CREATE TABLE keeper_cursors (
  keeper TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (keeper, market_pda)
);
