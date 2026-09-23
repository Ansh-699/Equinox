-- One Devnet faucet claim per wallet per interval (enforced by the Worker).
CREATE TABLE IF NOT EXISTS faucet_claims (
  wallet TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);
