# MagicBlock oracle adapter plan — 2026-09-22

This is a source/design artifact only. It authorizes no deployment or live
transaction.

## Observed external account

MagicBlock exposes a Pyth Lazer `PriceUpdateV3` account for feed 1435 at
`8L7ccCxTBZaLsMMdhAod5fFnpdEWGSDPW4y1td7y3y8N`. The account is 144 bytes and
refreshes in ER. The upstream MagicBlock oracle program uses the standard
Pyth receiver layout:

| region | bytes | value |
|---|---:|---|
| discriminator | 0–7 | account discriminator |
| write authority | 8–39 | oracle writer |
| verification level | 40 | `Full` required |
| feed id | 41–72 | 32-byte feed identifier |
| price | 73–80 | signed 64-bit raw price |
| confidence | 81–88 | unsigned 64-bit confidence |
| exponent | 89–92 | signed 32-bit exponent |
| publish time | 93–100 | signed 64-bit Unix timestamp |
| previous publish time | 101–108 | signed 64-bit timestamp |
| EMA fields | 109–124 | Pyth receiver fields |
| posted slot | 125–132 | unsigned 64-bit ER slot |

The account does not contain StockStream's channel ID, market session, trading
status, StockStream sequence, or `OracleSnapshotV3` authenticated-update
metadata. Its owner and account PDA must be checked; a price-only read is not
acceptable.

The current public account history is also inconsistent: the Pyth catalog
requires exponent `-5`, current bytes decode to `5`, and the historical
`InitializePriceFeed` instruction at slot `426478311` encoded `8`. The adapter
must stop on this mismatch and require MagicBlock to clarify or reinitialize
the feed with a documented wire version.

## Smallest safe implementation

1. **Done locally (diagnostics-only):** `src/magicblock_oracle.rs` provides a
   Rust `MagicBlockPriceObservation` decoder that rejects wrong owner,
   wrong PDA, short data, non-`Full` verification, wrong feed bytes, invalid
   confidence, future timestamps, stale timestamps, and exponent mismatch.
   It is not called by any risk or matching path.
2. Bind channel `2` and exponent `-5` to the configured instrument. Do not
   infer channel or exponent from an unauthenticated client value.
3. Bind market session and trading status to the active StockStream instrument
   and core state. Reject halted, restricted, closed, or mismatched states.
4. Use `posted_slot` only as provider metadata; do not treat it as a Pyth
   message sequence. Add a monotonic adapter sequence in the delegated
   observation boundary or retain the L1 snapshot sequence.
5. Keep the account readonly in every ER instruction. Never pass Pyth treasury,
   storage, payer, fee, or System Program accounts to ER.
6. Prefer materializing the validated result into an L1-owned
   `OracleSnapshotV3` before delegation. If direct ER consumption is selected,
   version the V3 instruction ABI and require the adapter account explicitly.

## Required tests before deployment

- Rust byte-layout round-trip and owner/PDA checks.
- Full-verification, feed, exponent, confidence, stale, future and replay
  rejection tests.
- Channel/session/status mismatch tests.
- ER instruction-meta test proving the adapter account is readonly and no
  Pyth fee accounts are present.
- A pinned MagicBlock integration test that observes one authenticated update,
  compares L1/ER values, measures propagation under ten seconds, and proves
  no owner debit.
- ABI parity for Rust and TypeScript adapter builders.

## Deployment boundary

This adapter changes the execution oracle ABI and therefore requires a new
artifact review. Do not upgrade the current program or create a fresh market
until the tests above pass and the adapter's exact account owner/schema is
confirmed against the deployed MagicBlock validator.
