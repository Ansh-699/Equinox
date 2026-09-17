-- Priority 8, Section 5: durable per-market ER/L1 execution-status
-- reconciliation state (`execution-status.ts`), persisted so a Worker
-- restart resumes from the last reconciled state rather than re-deriving
-- it from `l1_only` and potentially rejecting a real, already-observed
-- transition as "sequence did not advance."
CREATE TABLE execution_status (
  market_pda TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  sequences_json TEXT NOT NULL,
  error TEXT,
  updated_at INTEGER NOT NULL
);
