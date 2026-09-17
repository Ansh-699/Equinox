# MagicBlock

Only the market account is delegated today: StockStream's hot state (arenas,
seats, funding, event ring) lives in one PDA (`state::MARKET_ACCOUNT_SIZE`).
Vaults, deposits, withdrawals, the exchange/instrument registry and durable
authorities remain L1-only. The delegation-time automatic commit frequency is
30,000 ms, encoded into the `Delegate` instruction's `commit_frequency_ms`
field (program constant `magicblock::COMMIT_INTERVAL_MS` in
`programs/stockstream/src/magicblock.rs`) — see § Commit policy for why this
is a delegation argument, not a keeper knob.

**Settlement scratch and the hot cluster (RESOLVED, 2026-09-17 — Priority 10
exit requirement).** The matcher writes per-seat settlement scratch PDAs
(`["settlement", market, seat_index_le]`, `docs/settlement-scratch.md`) as
writable accounts inside `PlaceOrder`/`ReplaceOrder`, and session-signed
trading additionally writes the `TradingSession` PDA (nonce/notional
consumption, `programs/stockstream/src/handlers.rs::authorize_trading_actor`).
On the ER, **every writable account in a transaction must live in the same
execution domain**: an ER transaction cannot write the delegated market
account and an L1-resident, non-delegated writable account together (the ER
runtime rejects mixed domains; client-side, `lib/magicblock.ts::
validateTransactionAccountDomain` enforces the same matrix before
submission). The hot cluster is therefore delegated member-by-member:

```
Delegated hot cluster (all to ONE validator):
- Market account (arenas, seats, funding, event ring, delegation lifecycle)
- Active traders' settlement scratch PDAs (must be Empty at delegation;
  opcode 41 `DelegateClusterMember`, batchable post-instructions)
- Session traders' TradingSession PDAs (same opcode, after authorization)
- Delegated fee payer (future; see fee economics below)
```

**Resolution (option B — separately delegated to the same validator).** Each
member is delegated by the same Delegation-Program `Delegate` CPI the market
uses (`dlp_api` `DelegateArgs` with the member's own borsh seeds payload: 3
seeds for scratch `["settlement", market, seat_le]`, 5 seeds for session
`["trading_session", owner, market, seat_le, session_signer]`; buffer PDA
`["buffer", member]` under StockStream, record/metadata PDAs derived from the
member's address under the delegation program — verified byte-for-byte
against `dlp_api`'s own borsh serialization in `tests/magicblock.rs`).
`delegate_cluster_member` (opcode 41) requires the market to be already
delegated **to that exact validator** and keeps the market account READ-ONLY
(a delegated account must never be written on L1). The alternatives were
considered and rejected: **(A)** embedding scratch inside the market account
would change `MARKET_ACCOUNT_SIZE` (222,752) and the version-2 layout freeze
for a working-memory region; **(C)** ER-native ephemeral accounts are
unproven for this program's PDA validation, lifecycle, capacity, and
atomic-rollback requirements; **(D)** eliminating scratch is impossible — the
matcher's working memory exceeds the stack allowance and it must operate
directly on account bytes.

**Account-domain matrix** (writable accounts per instruction; L1/ER domain of
the writable set; commit behavior while delegated):

| Instruction | Writable accounts | Domain | Delegated? | Commit behavior |
| --- | --- | --- | --- | --- |
| PlaceOrder | market, seat scratch, session PDA (session-signed) | ER | all three required | committed in the market's commit intent bundle (`Standalone([2,3,...])`) |
| ReplaceOrder | market, seat scratch, session PDA | ER | all three | same |
| ReduceOnlyClose (PlaceOrder variant) | market, seat scratch, session PDA | ER | all three | same |
| CancelOrder / CancelAll | market, session PDA (session-signed) | ER | both | same |
| Funding (UpdateFunding) | market | ER | market | same |
| Liquidation (LIQUIDATE) | market | ER | market | same |
| Expiry/invalid cleanup | inside matching (market, placing seat scratch) | ER | both | same |
| ConsumeOracleUpdate | market + Pyth fee/treasury | **L1-only** | Pyth accounts can never be delegated | while delegated, live prices flow through a separately delegated ephemeral-oracle feed read instead (`docs/oracle.md`, `magicblock-labs/real-time-pricing-oracle` pattern) |
| Deposit / Withdrawal | vault, custody token accounts | **L1-only** | vaults are never delegated | n/a |
| DelegateMarket / DelegateClusterMember / CommitMarket / CommitAndUndelegate | payer, buffers, records | L1 | n/a (delegation lifecycle runs on L1) | n/a |

Enforcement: `magicblock::validate_cluster_member` gates trailing accounts on
`DelegateMarket` and committed accounts on `CommitMarket`/
`CommitAndUndelegate` (scratch must be `Empty` — no in-flight settlement plan
may cross a boundary; sessions must re-derive their PDA); the external-
undelegate callback routes on the replayed seeds and recreates the right
account kind with restoration-mismatch validation
(`magicblock::validate_restored_scratch` / `validate_restored_session`).
Client-side, `lib/magicblock.ts::validateTransactionAccountDomain` rejects a
mixed/invalid cluster before submission (`lib/magicblock-domain.test.ts`).

**Commit economics (verified 2026-09-17 against
docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics,
checked against source on 2026-08-20 upstream):** the delegation deposit
(delegation record + metadata rent) is charged at undelegation as `300,000`
lamports session fee + `100,000` per commit after the first, capped at the
deposit. Without a delegated fee payer, commits 1–10 are accepted and commit
11 fails (`0xA0000000`); a commit-and-undelegate still runs. With a delegated
fee payer + the validator's `magic_fee_vault`
(`["magic-fee-vault", validator]` under the delegation program,
`dlp_api::pda`), commits 1–25 are free and every commit from the 26th costs
`100,000` lamports **per committed account**, taken live from the delegated
fee payer. A 128-per-seat delegated scratch design would therefore cost
`12.8M` lamports per commit after commit 25 — unacceptable; the selected
policy delegates only the scratch/session PDAs of seats actually trading
during the ER session (for the devnet lifecycle run: 2 scratch + 2 session +
market = 5 committed accounts → ≤500k lamports/commit live after commit 25,
well inside the ≤10-commit no-fee-payer window for a bounded run).

**Exit test (Priority 10):** delegate market → delegate each cluster member
(scratch/session, same validator) → submit a crossing order through the
production settlement path on the ER → scratch goes Empty→Planning→Ready→
Empty inside the one instruction → commit the whole cluster → undelegate →
verify no mixed writable-account routing occurred and every member restored
byte-exactly (scratch Empty or closed per policy; session fields intact).

## Real CPI implementation

`programs/stockstream/src/magicblock.rs` implements actual cross-program
invocations, not local byte markers:

- `delegate_market`: creates the delegate buffer PDA, copies the market's
  (updated) state into it, zeroes and reassigns the market PDA
  (StockStream -> System Program -> Delegation Program), then invokes the
  Delegation Program's real `Delegate` instruction (discriminator `0`,
  7-account layout).
- `commit_market` / `commit_and_undelegate_market`: invoke the Magic
  Program's `ScheduleIntentBundle` instruction (`[payer, magic_context,
  market]` accounts) with a `Commit` or `CommitAndUndelegate` intent.
- `external_undelegate`: validates and consumes the delegation program's
  external-undelegate callback (`EXTERNAL_UNDELEGATE_DISCRIMINATOR =
  [196, 28, 41, 206, 48, 37, 51, 167]`), recreates the market account from
  the undelegate buffer, and only then marks the market `Restored`.

Program IDs, PDA seed tags and the callback discriminator are taken directly
from `magicblock-delegation-program-api` (`dlp_api`, `=3.1.0`) and
`magicblock-magic-program-api` (`=0.10.1`), which are real dependencies of
the `stockstream` crate (`default-features = false`: only their consts/PDA
helpers/args types are used, never their `AccountInfo`/`std`-based CPI
helpers, since StockStream is `no_std` with no heap allocator). The exact
wire bytes are hand-encoded into fixed-size arrays for that reason, and are
verified byte-for-byte against those crates' own `borsh`/`bincode`
serialization in `programs/stockstream/tests/magicblock.rs` (golden
vectors), plus against the delegation program's own
`processor/fast/{delegate,undelegate}.rs` source (fetched from
`magicblock-labs/delegation-program` during implementation) for account
order, signer/writable flags and the external-undelegate account/data
contract.

Local delegation-lifecycle state (`state::DelegationStatus`, validator,
delegation/commit sequence numbers, the pending-undelegation flag) lives in
`MarketStateHeader::reserved_upgrade` and is only mutated as part of an
instruction that also performs the corresponding CPI — a failed CPI aborts
the whole instruction, so no local state can drift from what the delegation
or Magic program actually accepted. L1 withdrawals are rejected
(`MagicBlockUndelegationInProgress`) whenever the market is anything other
than `NotDelegated`/`Restored`.

## Source references and licenses

Real, shipped dependencies of the `stockstream` crate:

| Crate | Version | License | Used for |
| --- | --- | --- | --- |
| `magicblock-delegation-program-api` (`dlp_api`) | `=3.1.0` | MIT | Program IDs, PDA seed tags/derivation, `DelegateArgs` shape, `EXTERNAL_UNDELEGATE_DISCRIMINATOR` |
| `magicblock-magic-program-api` | `=0.10.1` | MIT | Magic Program/Context IDs, `MagicBlockInstruction`/`MagicIntentBundleArgs` shape |

Both are pulled with `default-features = false`: only their `consts`/`pda`/`args` modules are used (pure data, no heap allocation); their `AccountInfo`-based CPI helpers are never linked (see "Real CPI implementation" above for why).

Additionally consulted, but **not a dependency and not copied into this repository**: the `magicblock-labs/delegation-program` GitHub repository's `src/processor/fast/{delegate,undelegate}.rs` source, read during implementation to ground the account order, signer/writable flags and the external-undelegate callback's account/data contract in the actual on-chain processor rather than guessing. That repository is licensed **Business Source License 1.1** (converts to MIT on 2027-12-01), a source-available but not OSI-open license restricting production use of *that* codebase specifically. StockStream contains no code copied or derived from it — only independently-written Pinocchio 0.11.2 code that implements the same wire protocol, using facts (account order, discriminator values, PDA seeds) that are also independently confirmed by the MIT-licensed `dlp_api`/`magic-program-api` crates above and by the `ephemeral-rollups-sdk` (`=0.17.0`, MIT) client SDK. Reading a BSL-licensed program's source to interoperate with its public
instruction interface is a technical provenance question that was reviewed
deliberately: StockStream does not copy or link the BSL-licensed processor
implementation. Its interoperable instruction encoding is independently
implemented using the published MIT-licensed API crates (`dlp_api`,
`magic-program-api`) and verified against observable protocol behavior.
This is a technical provenance statement, **not legal advice**; an
independent license review is required before any production claim.

`@magicblock-labs/ephemeral-rollups-kit` (MIT, an `npm` dependency) is referenced by `lib/magicblock-client.ts`, which is dead code not reachable from any production path -- see "Known scope limits" below.

## Known scope limits

- `lib/magicblock-client.ts` (deleted 2026-09-17) built top-level
delegation-program instructions directly via the official TS SDK, which
cannot actually execute (a PDA cannot sign a top-level client transaction;
delegation requires a CPI from the owning program, which is what
`magicblock::delegate_market` does). It was reachable only from its own
test file, was never wired into any route, component, or worker, and was
removed rather than retained as documented dead code because
architecturally-impossible transaction builders invite future misuse. The
real, invocable client path is
`clients/stockstream/src/index.ts::delegateMarket` /
`commitMarket` / `commitAndUndelegate`.
- Per-seat settlement scratch PDAs are validated `Empty` before delegating,
  committing, or undelegating, but are not themselves delegated in this
  pass (single-account delegation only). Extending this to loop the same
  CPI over each scratch PDA is straightforward if a real ER integration
  test needs per-seat ER-side scratch.
- The authorized keeper/authority for `CommitMarket` and
  `CommitAndUndelegate` is currently `header.market_authority` only — the
  Worker's role-bound signer registry (`workers/src/signer.ts`) is backend
  plumbing and does **not** confer any on-chain authority. This remains a
  real production authority gap: to operate with role separation the
  program needs a dedicated on-chain keeper-authority field (per market or
  exchange-wide) with an explicit instruction allowlist — commit but not
  undelegate, fund the fee payer, never update risk configuration — and the
  commit/undelegate handlers must check it instead of (or in addition to)
  `market_authority`. Until that lands, live ER operation must delegate
  this responsibility to the market authority key itself, which conflicts
  with the Worker signer model. See `docs/stockstream-roadmap.md` (Priority
  10 / 14d).
- `pinocchio::cpi::invoke_signed` is a no-op off the `solana`/`bpf` target,
  so a host `cargo test` run cannot observe the delegation/Magic programs
  actually executing. What is verified off-chain: every account/PDA/
  lifecycle/replay validation that runs *before* the CPI, and that the
  exact instruction bytes match the real crates' own serialization.
  End-to-end ER execution remains **SBF runtime unverified**, same as the
  rest of this program (see `docs/sbpf-compatibility.md`).

## Indexer-side execution-status model (Priority 5, `workers/src/execution-status.ts`)

The Worker keeps a separate, purely additive state machine
(`MarketExecutionStatus`: `l1_only -> delegating -> er_active ->
er_accepted -> commit_scheduled -> commit_observed_on_l1 ->
commit_finalized -> undelegating -> restoration_pending -> restored`,
with `reconciliation_error` reachable from any state on a conflicting or
regressed sequence) for **display purposes only** -- it answers "what
should the UI currently show for this market's ER/L1 status," never "is a
withdrawal actually safe." That question is answered entirely on-chain by
`DelegationStatus`/`l1_withdrawals_allowed()` in `programs/stockstream/src/state.rs`,
which this Worker-side model cannot weaken or bypass even if it were wrong.
It exists so the indexer/UI never displays ER-accepted state as if it were
L1-committed truth, and never silently advances past a sequence that
doesn't follow monotonically from what it last observed (any such
conflict is `reconciliation_error`, requiring an explicit, named recovery
call rather than self-healing).

**Update:** now wired to real on-chain state. `decodeDelegationFields`
decodes a market account's delegation status/sequence/commit-sequence
fields at their verified byte offsets; `reconcileFromL1` drives the state
machine from those decoded fields plus the ER's own observed event
sequence when currently delegated; `reconcileMarketExecutionStatus`
orchestrates the full read-decode-persist-publish cycle
(`ExecutionStatusRepository`, new `execution_status` table) and is exposed
via `GET /v1/markets/:symbol/execution-status`, publishing changes through
`MarketStream.publishExecutionStatus`. A first observation of an
already-mid-lifecycle market bootstraps directly into the matching status
rather than replaying every intermediate transition. Not live-network
verified. 20 tests in `execution-status.test.ts` (up from 9).

Also see `docs/transports.md` for the MagicBlock commit keeper and
`classifyWritableAccountDomain`'s L1/ER write routing (which fixed a real
bug this session: it checked for `DelegationStatus::Undelegating` at the
wrong numeric value, `4` instead of `2`).

## Verified ER runtime limits and commit economics (2026-09-17)

Verified against `docs.magicblock.gg` on 2026-09-17 (fee page states its
values were checked against MagicBlock source on 2026-08-20). The market
account (222,752 bytes) is far below the documented 10 MiB ER account-size
cap; the real risks are compute consumption while mutating the account,
account-borrow discipline, L1 delegation-transaction size, commit cost, and
whether the full account clones, commits, and restores byte-for-byte (the
Phase 1 verification test).

| Limit | Solana base layer | Ephemeral Rollup |
| --- | --- | --- |
| Compute units per instruction (default) | 200,000 CU | 200,000 CU |
| Compute units per transaction (max, `SetComputeUnitLimit`) | 1,400,000 CU | 1,400,000 CU |
| Serialized transaction size | 1,232 bytes | **64 KiB** |
| Account size (max) | 10 MiB | 10 MiB |
| Slot time | ~400 ms | ~10 ms |

The 64 KiB ER limit applies only to transactions whose writable accounts are
delegated; delegation/undelegation transactions route to L1 and remain
subject to the 1,232-byte limit. Slot times are explicitly not guaranteed
and must not be hardcoded into any protocol assumption -- measured latencies
(HUD stages) are the only claimable numbers.

### Fee model (two systems that can both charge)

1. **Solana delegation deposit** (funded at `delegate_market`, settled at
   undelegation, refundable for the unused portion): session charge
   `300,000` lamports, plus `100,000` lamports for each commit after the
   first. If the deposit is smaller than the calculated charge, MagicBlock
   takes the whole deposit and creates no debt -- so the deposit must be
   sized for the planned session length at the planned cadence.
2. **Live commit fees (fee-payer path).** Without a delegated fee payer,
   commits 1-10 are accepted and commit 11 fails with custom error
   `0xA0000000` (a final commit-and-undelegate still succeeds so the market
   is never trapped). With a delegated fee payer + the ER validator's
   `magic_fee_vault`, commits 1-25 carry no live fee and every commit from
   commit 26 onward costs `100,000` lamports per committed account,
   taken immediately from the fee payer. A commit charged live may
   additionally be counted in the deposit settlement at undelegation: the
   docs state an app "may pay both."

At StockStream's default 30,000 ms cadence: 120 commits/hour, 2,880/day,
~0.288 SOL/day/market in live fees from commit 26 onward, plus a
comparable deposit-side charge at undelegation -- roughly 0.57 SOL/day/market
for a full day at 30s cadence. This makes a universal fixed 30s policy
economically questionable for production.

### Commit policy

**Correction (2026-09-17):** an earlier version of this section claimed
low-activity markets could "commit every 2–5 minutes through Worker policy
without a program change." That was wrong and has been removed. The
30,000 ms value is encoded into the `Delegate` instruction's
`commit_frequency_ms` field (`encode_delegate_instruction_data`, offset
8..12; golden-vector tested against `dlp_api::args::DelegateArgs` in
`tests/magicblock.rs`), so the **delegation program auto-commits every
delegated market every 30 seconds** for as long as it stays delegated. The
Worker commit keeper's interval (`MIN_COMMIT_TICK_MS` in
`workers/src/keeper-jobs.ts`) is only the keeper's own scheduling minimum —
it cannot slow, accelerate, or skip the delegation program's automatic
commits. Client-side the same value is named
`DELEGATION_COMMIT_FREQUENCY_MS` (`lib/magicblock.ts`) to make this
explicit.

Consequences:

- **Every delegated market commits every 30 s and pays the full cost model
  below, until the program changes.** There is no low-activity cadence
  today.
- **Per-market commit policy is a program change**, required before any
  long-lived delegation, not after the demo: new `DelegateArgs` fields or a
  policy PDA plus matching `MarketStateHeader` fields in the free
  `reserved_upgrade` bytes (`155..185`, `docs/program-layout.md`):
  `commit_policy_version`, `periodic_commit_interval_ms`,
  `max_uncommitted_events`, `max_uncommitted_open_interest_delta`,
  `immediate_commit_flags` — version-gated under `MARKET_VERSION`
  discipline (no size change).
- Until then, the only cost levers are session length (delegate only for
  trading windows, then `commit_and_undelegate`) and the immediate
  commit-and-undelegate on planned boundaries (withdrawal request,
  corporate-action freeze).

### Exact fee estimator (dated configuration, not protocol constants)

With the delegation fee payer attached (live path), per delegated account:

```
deposit_charge = session_charge
              + max(commit_count - 1, 0) × deposit_commit_charge

live_charge    = max(commit_count - 25, 0) × live_commit_charge_per_account

estimated_total = deposit_charge + live_charge
                + callbacks + base_actions
```

Current dated values: `session_charge = 300_000` lamports,
`deposit_commit_charge = 100_000` lamports,
`live_commit_charge_per_account = 100_000` lamports,
`callback_charge = 5_000` lamports per callback,
`base_action_price = ceil(compute_units × 50_000 / 1_000_000)` lamports.

For 2,880 commits (one account, 30 s cadence, 24 h): deposit side
`0.0003 + 2,879 × 0.0001 = 0.2882 SOL`; live side `2,855 × 0.0001 =
0.2855 SOL`; **≈ 0.5737 SOL/day/market**. The commit keeper must treat
these as configuration and re-derive totals from the live fee source
rather than hardcoding them.

### Fee-payer runway state (keeper-exposed)

The commit keeper should compute and expose per delegated market:
`commit_count`, `deposit_remaining`, `fee_payer_balance`,
`estimated_commits_remaining`, `estimated_session_hours_remaining`,
`last_commit_cost`, `rolling_daily_cost` — alerting and scheduling
planned undelegation **before** either the fee payer or the deposit is
exhausted. `InsufficientFunds` on a scheduled commit fails the whole
bundle; an undersized deposit is silently absorbed at undelegation (no
debt, but the refund disappears). These values belong in the
`tx_attempts`/keeper-health surfaces (`GET /v1/health/keepers`).

### Other verified charges relevant to the demo

- Base Action (post-commit L1 instruction): `price = ceil(compute_units *
  50_000 / 1_000_000)` lamports from the delegated fee payer (a 200,000 CU
  action costs 10,000 lamports); a callback costs an additional 5,000
  lamports.
- Fee-payer top-up via `lamportsDelegatedTransferIx` currently carries a
  `300,000`-lamport setup charge (distinct from, but currently equal to, the
  delegation session charge).
- Ephemeral Accounts (ER-only, never commit to L1) reserve refundable
  storage of `(data_bytes + 60) * 32` lamports.
- Normal ER transactions are `0` in the current release; Solana transaction
  fees are separate.

Source pages: `docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits.md`
and `.../fees-and-commit-economics.md` (which lists the two source
repositories to re-check for production: `delegation-program` at commit
`6898ef4b...` and `magicblock-validator` at commit `cec4cf57...`).

## Complete cluster economics (measured from the ACTUAL implementation, 2026-09-17)

`scripts/magicblock-economics.py` computes these from the real cluster
implementation (market 222,752 B + 12,288 B scratch + 256 B session per
active trader) and the delegation program's own pinned constants
(`dlp_api` 3.1.0: `COMMIT_FEE_LAMPORTS = 100_000`, `SESSION_FEE_LAMPORTS =
300_000`) plus the documented live-fee model (commits 1-25 free with a
delegated fee payer; every commit from the 26th costs 100,000 lamports per
committed account; the undelegation deposit charge caps at the deposit
held).

| Traders | Delegated accounts | One-time refundable deposit rent | Live commit fees (full day, auto-commits at 30s) | 24h runway | 7d runway |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 0.0099 SOL | 0.8565 SOL/day | 0.8565 | 5.9955 |
| 2 (lifecycle run) | 5 | 0.0166 SOL | 1.4275 SOL/day | 1.4275 | 9.9925 |
| 10 | 21 | 0.0696 SOL | 5.9955 SOL/day | 5.9955 | 41.9685 |
| 50 | 101 | 0.3346 SOL | 28.8355 SOL/day | 28.8355 | 201.8485 |
| 128 | 257 | 0.8514 SOL | 73.3735 SOL/day | 73.3735 | 513.6145 |

**Operational implication (honest):** with `commit_frequency_ms = 30_000`
(a delegation argument, not a knob) each delegated account auto-commits
2,880 times/day. Without a delegated fee payer the 10-commit ceiling stops
the ER after ~5 minutes; with one, long-lived 24/7 operation at 50 traders
costs ~29 SOL/day in live fees. That is impractical for always-on
multi-trader operation at the current cadence and must be reduced by a
program change (longer commit interval / explicit-commit-only policy)
BEFORE mass delegation — the bounded devnet lifecycle below therefore runs
bounded sessions (delegated, a handful of trades, commit, undelegate), not
a 24h always-on market, and the fee-payer top-up path stays future work.
