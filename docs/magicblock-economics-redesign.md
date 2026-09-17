# MagicBlock Continuous-Operation Economics: Design Comparison

Status: **Analysis and recommendation.** Verified against
`scripts/magicblock-economics.py` (actual cluster implementation) and the
delegation program's pinned constants (`dlp_api` 3.1.0:
`COMMIT_FEE_LAMPORTS=100_000`, `SESSION_FEE_LAMPORTS=300_000`), plus the
documented live-fee model (fees-and-commit-economics, source-checked
2026-08-20 upstream, re-verified 2026-09-17). No production state layout was
changed by this document. All costs in SOL/day unless noted; lamport figures
are exact.

## Cost model inputs (measured)

- One delegated account = one record + metadata deposit (refundable at
  undelegation, capped at the deposit held) + one clone to the ER.
- Auto-commit every 30,000 ms = 2,880 commits/day/account.
- Commits 1–25 free with a delegated fee payer; from commit 26 every bundle
  costs 100,000 lamports **per committed account**.
- Without a delegated fee payer: commits 1–10 accepted, commit 11 fails
  (`0xA0000000`), commit-and-undelegate still works.
- 30s cadence ⇒ after the free window every account pays 100,000 lamports
  per commit → 0.0002857 SOL/account/hour ≈ 0.00686 SOL/account/day.

## Design comparison

| Design | Delegated accts (2 traders) | Committed accts | SOL/day (2 tr) | SOL/month | Onboarding (per new trader) | Revocation | Crash recovery | Atomic rollback | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Current** (market + per-trader scratch + session) | 1+2T | all (1+2T) | 1.43 | 42.8 | 2 delegations + deposits | revoke on L1; ER state persists until undelegate | restored by undelegate | instruction-level rollback preserved | cost scales as 3 accounts/trader |
| **B. Market + shared market-level scratch** | 1+T (sessions only) or 1 | 1+T or 1 | 0.29 (1 acct) | 8.6 | 0–1 | session revocation = L1 revoke | market-only commit | preserved | scratch capacity must handle concurrent settlement plans; current matcher is single-plan-per-instruction (seat-indexed), shared scratch = serialization point |
| **C. Market + ER-native transient scratch** | 1+T | 1 (market only) | 0.29 | 8.6 | 1 (session only) | same as A | market-only commit | scratch never durable → no commit conflict | scratch as Ephemeral Account: 32 lamports/byte ⇒ 12,288B scratch = 393,632 lamports/day storage (refundable), still needs per-tx sponsor; matcher rewrite to ER-native allocation is unproven for PDA validation/rollback (documented in magicblock.md) |
| **D. Session PDA stays L1, nonce in seat** | 1+T (scratch only) or 1 | 1+T or 1 | 0.29–0.86 | 8.6–25.7 | 0–1 delegations | nonce advances on L1 ⇒ instant revocation | commit restores market only | preserved | **breaks the ER execution domain**: a session-signed ER trade writes the session PDA (nonce consumption) — if the session stays L1 the transaction has a non-delegated writable account and is rejected by the ER runtime |
| **E. Session state consolidated into the delegated market** | 1+T (scratch) or 1 | 1+T or 1 | 0.29–0.86 | 8.6–25.7 | 0 delegations for sessions | nonce in market data ⇒ commit-bounded revocation (revocation takes effect at the next L1 commit, ≤ 30s) | preserved | preserved | requires MARKET_VERSION 3 layout migration (risky, deferred) |
| **F. Longer commit interval (e.g. 300s)** | 1+2T | 1+2T | 0.143 | 4.3 | same as A | unchanged | unchanged | unchanged | commit_frequency_ms is a **delegation argument** — program-side change required (roadmap Priority 10); 10× cost reduction without any layout change |
| **G. Explicit event-triggered commits only** | 1+2T | on demand | ~0 (keeper-triggered) | ~0 | same as A | commits still bounded by fee payer | same as A | preserved | requires `commit_frequency_ms = u32::MAX` delegation argument + a keeper-driven commit policy (real program change, single constant) |
| **H. Market-hours-only delegation** | 1+2T during hours | 1+2T | 0.43 (2 traders, 6.5h/day) | 12.9 | same as A | undelegate at close | full restore nightly | preserved | bounded session per day; equilibrium with ≤10-commit no-fee-payer path; ~12.9 SOL/month at 2 traders, ~147 SOL/month at 50 |

## Exact per-design cost model (per day, fee-payer path, from commit 26)

Per-account live commit fee = max(0, commits/day − 25) × 100,000 lamports.
With `commit_frequency_ms = 30_000`: max(0, 2880 − 25) × 0.0001 SOL =
0.2855 SOL/account/day.

| Design | Committed accounts (T traders) | SOL/day | SOL/month |
| --- | --- | --- | --- |
| A/F (1+2T) | 1+2T | (1+2T) × 0.2855 | ×30 |
| B/C (1+T or 1) | (1+T) or 1 | 0.2855 × (1+T) or 0.2855 | ×30 |
| D/E (1+T or 1, sessions in market) | same as B/C | same as B/C | ×30 |
| G/H (on demand / bounded hours) | usage-dependent | usage × 0.0001/account-commit | usage-dependent |

## Recommendation (evidence-based, safe, no layout migration yet)

**Adopt F+G as the program change (both are delegation-argument changes,
no state-layout migration):**

1. Make `commit_frequency_ms` a market-authority-settable delegation
   argument (currently hard-coded 30,000 via `COMMIT_INTERVAL_MS`). Set it
   to `u32::MAX` (explicit commits only) or 300,000–600,000 ms for
   continuous markets. This is a **one-constant change plus a policy
   field**, no account layout change, no migration.
2. Keep per-trader scratch + session members (design A's cluster) — the
   account-domain matrix already requires them in the ER domain for
   session-signed trading; B/C/E require deeper unproven changes.
3. The keeper schedules explicit commits (design G) at session close,
   funding settlement, and reconciliation — the bounded devnet lifecycle
   already demonstrates ≤10 commits without a fee payer.

**Rejected designs:** D breaks the ER execution domain (session PDA nonce
writes must live in the delegated cluster — the matrix in
`lib/magicblock.ts` enforces exactly this). E is safe but a MARKET_VERSION
3 migration must not be rushed for cost alone. C (ER-native transient
scratch) remains unproven for this program's PDA validation and atomic
rollback requirements (`docs/magicblock.md`).

## Monthly cost table (recommended F+G at 600s cadence, 2 traders)

- Delegated accounts: 5; commits/day/account: 144; free: 25 → live fees =
  5 × 0.0001 × (144−25) = 0.0119 SOL/day → **0.36 SOL/month** at 2 traders.
- 50 traders: 101 accounts → 0.2975 SOL/day → **8.9 SOL/month** — still
  requiring the explicit-commit policy for true public operation, but
  bounded-hours operation with the u32::MAX cadence is ~0 cost for idle
  accounts.

## Security tradeoffs (documented, not changed)

- Explicit commits (F/G): an ER crash before commit loses uncommitted
  state — bounded by the committed-sequence guard and the durable L1 state;
  the crash-recovery story is "re-delegate from the last committed state",
  identical to today's recovery, just less frequent.
- Long commit intervals delay L1 observability of trades — the two-clock
  UI's commit-pending count already models this (`workers/src/
  execution-status.ts`), and withdrawals are gated by
  `l1_withdrawals_allowed()`, not by commit cadence.
- No design here changes session authorization semantics, revocation
  immediacy (L1 instruction, not commit-gated), rollback, or durable
  state.
