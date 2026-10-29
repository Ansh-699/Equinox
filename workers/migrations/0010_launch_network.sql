-- Launches are listed per network: devnet curves (test USDC) and mainnet curves (USDC).
ALTER TABLE launches ADD COLUMN network TEXT NOT NULL DEFAULT 'devnet';
