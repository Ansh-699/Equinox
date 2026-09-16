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

## Known scope limits

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
