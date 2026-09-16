# MagicBlock

Only the market account is delegated: StockStream's entire hot state (arenas,
seats, funding, event ring) lives in one PDA (`state::MARKET_ACCOUNT_SIZE`),
so the "hot cluster" is that single account. Vaults, deposits, withdrawals,
the exchange/instrument registry and durable authorities remain L1-only. The
configured commit interval is 30,000 ms, enforced as a protocol constant (not
caller-supplied) in `magicblock::COMMIT_INTERVAL_MS`.

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

Additionally consulted, but **not a dependency and not copied into this repository**: the `magicblock-labs/delegation-program` GitHub repository's `src/processor/fast/{delegate,undelegate}.rs` source, read during implementation to ground the account order, signer/writable flags and the external-undelegate callback's account/data contract in the actual on-chain processor rather than guessing. That repository is licensed **Business Source License 1.1** (converts to MIT on 2027-12-01), a source-available but not OSI-open license restricting production use of *that* codebase specifically. StockStream contains no code copied or derived from it — only independently-written Pinocchio 0.11.2 code that implements the same wire protocol, using facts (account order, discriminator values, PDA seeds) that are also independently confirmed by the MIT-licensed `dlp_api`/`magic-program-api` crates above and by the `ephemeral-rollups-sdk` (`=0.17.0`, MIT) client SDK. Reading a BSL-licensed program's source to interoperate with its public instruction interface, without incorporating its code, does not implicate the BSL's use restrictions.

`@magicblock-labs/ephemeral-rollups-kit` (MIT, an `npm` dependency) is referenced by `lib/magicblock-client.ts`, which is dead code not reachable from any production path -- see "Known scope limits" below.

## Known scope limits

- `lib/magicblock-client.ts` builds top-level delegation-program instructions
  directly via the official TS SDK, which cannot actually execute (a PDA
  cannot sign a top-level client transaction; delegation requires a CPI from
  the owning program, which is what `magicblock::delegate_market` does).
  Nothing imports it outside its own test file
  (`lib/magicblock-client.test.ts`); it is not wired into any route,
  component, or worker. The real, invocable client path is
  `clients/stockstream/src/index.ts::delegateMarket` /
  `commitMarket` / `commitAndUndelegate`.
- Per-seat settlement scratch PDAs are validated `Empty` before delegating,
  committing, or undelegating, but are not themselves delegated in this
  pass (single-account delegation only). Extending this to loop the same
  CPI over each scratch PDA is straightforward if a real ER integration
  test needs per-seat ER-side scratch.
- The authorized keeper/authority for `CommitMarket` and
  `CommitAndUndelegate` is currently the market's own `market_authority`;
  a dedicated keeper-authority field is deferred to the scheduled-keeper
  work (see `docs/keepers.md`).
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
call rather than self-healing). It is not yet wired to real on-chain
commit-schedule/commit-observation data -- that would mean decoding actual
delegation-program/magic-program account state, which hasn't been built.
9 tests in `execution-status.test.ts`.
