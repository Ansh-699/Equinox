ALTER TABLE keeper_leases ADD COLUMN fence INTEGER NOT NULL DEFAULT 1;
CREATE TABLE operation_keys (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX operation_expiry ON operation_keys(expires_at);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_expiry ON rate_limits(expires_at);
