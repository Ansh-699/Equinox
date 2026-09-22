# Local L1/ER compatibility status — 2026-09-22

This is a read-only release-gate record. No Devnet transaction was submitted
while producing it.

## Proven locally

- `OracleSnapshotV3` is 128 bytes, L1-owned, and excluded from the 27-account
  delegated execution bundle.
- Snapshot validation checks feed ID, channel, exponent, authenticated bit,
  sequence, confidence, publish time, market session, and ten-second freshness.
- Snapshot price selection takes precedence over a different cached core price
  after freshness validation.
- ER-facing V3 builders do not include Pyth treasury, storage, fee, or payer
  accounts.
- Session authorization, order placement, replacement, liquidation, funding,
  deposit, and withdrawal builders can carry the snapshot as readonly metadata
  where their ABI permits it.

## Read-only MagicBlock oracle probe

The canonical MagicBlock Pyth Lazer PDA for feed 1435 was queried at both L1
and the Asia ER endpoint. It exists at
`8L7ccCxTBZaLsMMdhAod5fFnpdEWGSDPW4y1td7y3y8N`, with 144-byte data. L1 reports
the delegation owner while ER reports the MagicBlock oracle-program owner, so
ER-side oracle data is present. This is evidence of an available price-feed
account, not evidence that StockStream can safely consume it: the account does
not carry StockStream's channel, market-session, trading-status, sequence, and
authenticated-snapshot fields. The latest samples report verification level
`Full`, but encode exponent `5` (while StockStream requires `-5`) and confidence
`0`; the adapter therefore rejects them rather than guessing a sign or
confidence interpretation. Full redacted probe data is in
`docs/status/magicblock-oracle-probe-20260922.json`.

Account history adds a provenance mismatch: the public `InitializePriceFeed`
transaction at slot 426478311 (`2RemknQv…`) encoded trailing exponent `8`,
while the current account bytes decode to `5`. This is recorded as an observed
wire-version/provenance inconsistency, not interpreted or repaired locally.

An ER WebSocket subscription also observed three successive updates at slots
612399707, 612399727, and 612399748. This proves the MagicBlock feed account is
live and refreshing; it still does not prove L1 `OracleSnapshotV3` read-through
or StockStream-compatible metadata validation.

The result is reproducible with the read-only command:

```text
npm run probe:er-compatibility
```

The probe derives the PDA from `config/stockstream-deployment.json`, performs
only `getAccountInfo` calls, and closes after observing three ER WebSocket
notifications. It exits without a signer, transaction builder, or mutation
path.

## Not proven

The repository does not yet contain a real L1+MagicBlock validator integration
test that performs an authenticated L1 snapshot write and measures its
visibility in ER. Existing tests use local account views and fixtures; they do
not prove validator read-through latency or ER account mutability.

An initial runtime attempt used the library-only ELF and LiteSVM rejected it
before execution with:

```text
ProgramLoad("Multiple or no text sections, consider removing llc option: -function-sections")
```

The production SBF was then rebuilt with the required `bpf-entrypoint` feature.
All enabled LiteSVM runtime tests pass against that artifact, including V3
creation, vault/custody, session, delegation, settlement, and oracle tests.
This proves local runtime behavior, but it still does not prove a real
MagicBlock validator's L1-to-ER snapshot propagation latency.

## Required acceptance evidence

Before a fresh market is created, the integration harness must prove:

1. L1 snapshot sequence, price, and timestamp advance.
2. The snapshot remains owned by StockStream on L1.
3. ER reads the same sequence and price within ten seconds.
4. Stale, future, wrong-feed, wrong-channel, wrong-exponent, invalid-confidence,
   and non-open-session snapshots fail in ER.
5. ER writes no Pyth accounts and performs no owner-funded Pyth verification CPI.
6. The pre-created session PDA is writable through the supported ER lifecycle
   without an unexpected System Program debit.
