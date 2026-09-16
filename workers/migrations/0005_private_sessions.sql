CREATE TABLE private_sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  market_pda TEXT NOT NULL,
  seat_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX private_sessions_expiry ON private_sessions(expires_at);
