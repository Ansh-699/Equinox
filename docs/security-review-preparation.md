# Security Review Preparation

Status: **Preparation package for an independent audit.** This is NOT an
audit. Every matrix here is derived from the actual implementation
(file/function references included) so a reviewer can trace each claim.

## 1. Authority matrix (who can do what, on-chain)

| Authority | Can | Cannot | Verified by |
| --- | --- | --- | --- |
| Deploy authority (`A5sV4Pkk…`) | program deploy/upgrade; holds market authority for its own markets | is NOT the protocol keeper, NOT a browser/session key | `docs/equinox-devnet-release-gate.md` |
| Market authority (`header.market_authority`) | InitializeVault, UpdateFunding, UpdateMarketRisk, TransitionMarket, registry ops, DelegateMarket/CommitMarket | withdraw user collateral; move user funds | `handlers.rs::update_funding` (`IllegalOwner` gate) |
| Emergency authority | Liquidate | market administration | `handlers.rs::liquidate` (`authority == header.emergency_authority`) |
| Keeper authority (exchange config) | ReconcileVault, ResolveBadDebt, funding scheduling (when wired) | withdraw user collateral; move fees | `error.rs`/`instruction.rs` allowlists; `workers/src/keeper-signer.ts` |
| Keeper signer (LOCAL_DEVNET/secret) | sign ONLY: UpdateFunding, Liquidate, ConsumeOracleUpdate, CommitMarket, CommitAndUndelegate, session limits, ResolveBadDebt, ReconcileVault | deposits/withdrawals/session authorization/market administration | `KEEPER_INSTRUCTION_ALLOWLIST` + `auditKeeperTransaction` |
| Relayer (Worker) | co-sign session-signed trade transactions (place/cancel/cancelAll/replace only) | alter approved instructions; submit custody opcodes | `workers/src/session-relayer.ts::SESSION_ALLOWED_OPCODES` |
| Trading session signer | the session's allowlisted actions (place/cancel/cancelAll/replace/reduce-only), bounded by notional/exposure/nonce | deposits, withdrawals, session authorization, market administration | `session.rs::SESSION_ACTION_*`, `handlers.rs::authorize_trading_actor` |
| User main wallet | deposit, withdraw, authorize/revoke sessions, seats | — | `handlers.rs` custody instruction lists (no session account parameter) |

## 2. Signer-role matrix

| Role | Key material | Where held | Never |
| --- | --- | --- | --- |
| Deploy/upgrade authority | `~/.config/solana/id.json` (600) | local CLI | in a Worker, browser, or keeper |
| Market administrator | `header.market_authority` keypair | operator | the browser |
| Keeper | `KEEPER_KEYPAIR_JSON` (untracked env) | local devnet tooling | a browser bundle |
| Relayer fee payer | Worker secret binding (CLOUDFLARE_FUTURE) | Worker secret store | D1/KV/browser |
| Browser session signer | WebCrypto key in memory (module closure) | browser only | backend, D1, KV, logs, URLs, cookies |
| User main wallet | Privy-managed | user device | any server |

## 3. Instruction/account matrix

All 43 opcodes with their writable/signable accounts are enumerated in
`programs/equinox/src/instruction.rs` (decode) and
`programs/equinox/src/handlers.rs` (dispatch). The account-domain
matrix (ER vs L1 writable sets per trading instruction) is
`lib/magicblock.ts::ER_WRITABLE_CLUSTERS` and `docs/magicblock.md` § matrix.

## 4. PDA derivation inventory

| PDA | Seeds | Owner | Used by |
| --- | --- | --- | --- |
| perp-market | `["perp-market", instrument]` | Equinox | market state (delegation target) |
| instrument | `["instrument", id]` | Equinox | registry linkage |
| exchange | (keypair in the current lifecycle; PDA not required) | Equinox | governance |
| vault | `["vault", market]` | Equinox | collateral custody |
| vault-authority | `["vault-authority", market]` | Equinox | vault signing authority |
| settlement scratch | `["settlement", market, seat_le]` | Equinox | per-seat settlement working memory |
| trading session | `["trading_session", owner, market, seat_le, session_signer]` | Equinox | scoped trading authorization |
| delegate buffer | `["buffer", <delegated account>]` | Equinox | delegation in-flight copy |
| delegation record | `["delegation", <account>]` | Delegation Program | MagicBlock |
| delegation metadata | `["delegation-metadata", <account>]` | Delegation Program | MagicBlock (seeds replay) |
| undelegate buffer | `["undelegate-buffer", <account>]` | Delegation Program | restoration signer |
| magic fee vault | `["magic-fee-vault", validator]` | Delegation Program | live commit fees (future) |

## 5. Writable-domain matrix

`lib/magicblock.ts::validateTransactionAccountDomain` + the on-chain
`magicblock.rs::validate_cluster_member` gate: while the market is
delegated, every writable account a trading instruction writes (market,
seat scratch, session PDA) must be delegated to the SAME validator.
`ConsumeOracleUpdate` is L1-only (writes Pyth-owned accounts).
Deposits/withdrawals are L1-only. Mixed-domain transactions are rejected
by the ER runtime and by the client-side validator pre-submission.

## 6. Custody invariants

- Canonical vault + vault-authority PDA model (Model A); aliases rejected
  (`validate_custody_aliases` — all 7 accounts distinct).
- Ledger credit before CPI, write after CPI, atomic rollback on failure
  (documented in `handlers.rs::deposit_collateral`).
- Reconciliation: deficit auto-pauses the market; escalation to
  `RecoveryRequired` blocks withdrawals (`ReconcileVault`).
- Withdrawals gated by `l1_withdrawals_allowed()` (never delegated/undelegating).
- Session signer STRUCTURALLY cannot reach deposit/withdraw (no session
  account parameter in the custody instruction list).

## 7. Risk invariants

- The oracle must be verified (`oracle_valid == 1`) and fresh
  (monotonic `feedUpdateTimestamp`, ≤ 10s old, feed-vs-envelope ordering)
  for any risk-increasing operation.
- Mark price is computed ON-CHAIN from the book + verified oracle
  (`mark.rs`); funding increments are bounded by the per-second cap AND
  the mark/index basis — a keeper cannot select an arbitrary funding rate
  (runtime-verified, `tests/runtime_funding_liquidation_session.rs`).
- Pegged orders: Invalid/Skipped states are excluded from matching and
  the mark; expiry honored per leaf.
- Session limits: per-order notional, cumulative notional, exposure,
  open orders, nonce monotonicity — enforced in `authorize_trading_actor`.

## 8. Session-key threat model

- Generation: browser-local Ed25519 (WebCrypto), memory-only module
  closure; never serialized anywhere (`lib/browser-session.ts`).
- Authorization: one main-wallet transaction grants scoped actions with
  limits/expiry (`AuthorizeTradingSession`); trades are signed by the
  session key and relayed with the Worker's fee-payer co-signature.
- Revocation: main-wallet L1 instruction; session-signed trades rejected
  immediately after (`is_live` check).
- Theft scenario: a stolen browser session holds a session key — cannot
  move collateral (no custody path), cannot widen limits (on-chain), and
  a persisted session cannot re-authorize silently.
- Clearing: logout/revocation/expiry/reload destroy the key permanently.

## 9. Relayer threat model

- The relayer validates: fee-payer identity (its own address, unsigned),
  an existing session-signer signature over the EXACT message bytes, and
  the opcode allowlist — then co-signs the same message bytes and
  submits. It cannot alter the instruction without breaking the
  session's own signature. Rate limited per caller. Bearer-token-only
  access never authorizes a trade alone: the on-chain session account
  + signature are the authority.

## 10. Oracle threat model

- Pyth Pro signed payloads are verified on-chain (Ed25519 CPI + trusted
  signer + feed identity + confidence/price bounds + freshness); the
  keeper never submits an authoritative price — it submits a SIGNED
  payload the program verifies.
- Analytics/tokenized-stock feeds are never risk inputs.
- Stale/halted oracle blocks risk-increasing operations (no fallback
  price).

## 11. Keeper threat model

- Keeper signers are role-separated; the instruction allowlist is
  enforced by `auditKeeperTransaction` BEFORE submission (unknown
  programs, custody opcodes, system transfers rejected).
- Devnet-only network guard: a keeper signer is refused against any
  non-devnet endpoint (`isDevnetOnlyEndpoint`).
- Keeper leases with fencing tokens prevent concurrent double-runs;
  idempotency keys prevent duplicate submissions; dead letters bound
  retry storms.

## 12. Delegation/commit failure matrix

| Failure | Detection | Recovery |
| --- | --- | --- |
| Delegation CPI fails | atomic instruction rollback | state unchanged; retry after funding |
| Commit CPI fails | atomic rollback | sequence unchanged; next tick retries |
| Commit scheduled but L1 finalize delayed | execution-status reconciliation (ER-accepted ≠ L1-finalized) | UI shows commit-pending; withdrawals blocked by `l1_withdrawals_allowed` |
| Undelegation callback for a foreign account | `MagicBlockInvalidCallback` | reject; no state change |
| Restoration byte mismatch | `validate_restored_scratch/session` | reject (never overwrite live state) |
| Mixed writable-domain ER tx | ER runtime rejects pre-execution | resubmit through L1 after undelegation |

## 13. Economic assumptions

- 100,000 lamports/account/commit from commit 26 (delegation program
  constant); 300,000 lamports session charge; commits 1–25 free with a
  delegated fee payer; commits 1–10 without one.
- Current 30s cadence: 0.2855 SOL/account/day live — impractical at
  scale; the recommended redesign (explicit commits, delegation-argument
  change) reduces it to usage-based cost (`docs/
  magicblock-economics-redesign.md`).

## 14. Known limitations

- The deployed Devnet ELF (sha `23b6922b…`) predates the
  allocate-first reorder in the PDA-creation CPIs; a funded upgrade is
  pending (wallet at 0.203 SOL).
- The bounded devnet lifecycle (delegation → ER trade → commit →
  undelegation → withdrawal) is not yet executed against the live
  Delegation Program — **no MagicBlock runtime claim is made**.
- No rotated Pyth Pro or Privy credentials installed; live stream and
  real-browser flows are configuration-blocked.
- LiteSVM runtime tests execute the real `.so` locally but do NOT execute
  the real Delegation/Magic Programs (documented honestly in every
  delegation test's doc comment).

## 15. Checks executed for this review

- `cargo fmt --check`, `cargo check`, 214+214 Rust tests, 51 SBF runtime tests
- `npx tsc --noEmit` (root + workers), 67 root TS + 297 Worker tests, eslint
- `cargo build-sbf` + `scripts/verify-sbf-artifact.py` (EI_OSABI 0, no
  SHF_GNU_RETAIN, entrypoint, program ID)
- Reproducibility from a clean worktree (byte-identical)
- `scripts/secret-scan.sh` — OK; `.next/static` bundle scan — clean
- Dependency audit: `npm audit --omit=dev` (run below; recorded in the
  report)

**This document is review PREPARATION, not an audit. Production is not
approved.**

## 16. Dependency audit result (2026-09-18, production deps only)

`npm audit --omit=dev`: **41 vulnerabilities (3 low, 31 moderate, 7 high)**
in transitive runtime dependencies (notably `bigint-buffer` high,
`bn.js` ≤5.2.2 moderate via @solana SDK chains). None with a known
exploitable path in this repo's usage yet; recorded for the independent
audit's supply-chain review. No automatic fix was applied (`audit fix
--force` would force-breaking SDK upgrades).
