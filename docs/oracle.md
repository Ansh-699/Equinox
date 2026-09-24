# Oracle

Pyth Pro/Lazer is the sole production risk oracle. `PYTH_PRO_API_KEY` is not
present in source or bundles; authenticated catalog access and signed AAPL
verification remain externally blocked, but the full on-chain verification
path and deterministic fixtures are complete and tested.

## Verified against the real Pyth Lazer source

Every constant, account, and byte offset checked in
`handlers::consume_oracle_update` was read directly from
`pyth-network/pyth-lazer-public` on GitHub during implementation:

- `contracts/solana/programs/pyth-lazer-solana-contract/src/lib.rs` for the
  on-chain verifier's program ID, the `Storage` account layout (`top_authority`,
  `treasury`, ...), and the `verify_message` Anchor instruction's accounts
  (`payer`, `storage`, `treasury`, `system_program`, `instructions_sysvar`).
  Its 8-byte Anchor discriminator is independently reproduced as
  `sha256("global:verify_message")[..8]` rather than trusted as a bare
  literal.
- `contracts/solana/programs/pyth-lazer-solana-contract/src/signature.rs` for
  the Ed25519-instruction sysvar-introspection contract this program's own
  pre-CPI check mirrors, and for `EXTERNAL_UNDELEGATE`-style ground truth
  such as `EXTERNAL_UNDELEGATE_DISCRIMINATOR`-equivalent constants (the
  `[196, 28, 41, 206, 48, 37, 51, 167]` MagicBlock discriminator, verified
  separately -- see `docs/magicblock.md`).
- `sdk/rust/protocol/src/message.rs` for the `SolanaMessage` envelope
  (`magic(4) || signature(64) || public_key(32) || payload_len(2) ||
  payload`) and `SOLANA_FORMAT_MAGIC`.
- `sdk/rust/protocol/src/payload.rs` for the tag-length-value `PayloadData`
  format and `PAYLOAD_FORMAT_MAGIC`.
- `sdk/rust/protocol/src/api.rs` for the real `PriceFeedProperty` enum
  discriminants and the `MarketSession` enum (`Regular=0, PreMarket=1,
  PostMarket=2, OverNight=3, Closed=4`).

The keeper (`lib/server/pyth-keeper.ts`) always requests exactly five
properties, in this order: `price, exponent, confidence, marketSession,
feedUpdateTimestamp` (`PriceFeedProperty` discriminants `0, 4, 5, 9, 12`).
This fixes the payload's shape so the program can validate exact property
tags and offsets instead of writing a general TLV parser -- a payload
requesting a different property set is rejected outright, at
`parse_verified_oracle`'s explicit tag check.

**A real bug this cross-referencing found and fixed:** the payload length
this program checked for was `60`; the actual TLV encoding of those five
properties (verified field-by-field against `write_option_price` /
`write_option_timestamp` in the real crate) is `53` bytes. The prior value
would have rejected every genuine Pyth Lazer update with this property set.
Now `53` (with a compile-time-documented byte breakdown in
`parse_verified_oracle`).

## What changed from the marker/CPI-only version

- **Instructions-sysvar inspection is real**, not assumed. The prior
  implementation hardcoded `ed25519_instruction_index = 0` and
  `signature_index = 0` in the CPI call without checking either. Now both
  are explicit `ConsumeOracleUpdate` instruction-data fields supplied by the
  keeper (who controls transaction layout), and this program independently
  loads the Instructions sysvar, confirms the claimed index names a real
  instruction that precedes the current one, that its program ID is the
  native Ed25519 program, and that the claimed signature index is in
  bounds -- all *before* the CPI into Pyth's own `verify_message`, which
  repeats this check authoritatively (plus the actual signature and
  trusted-signer verification this program cannot itself perform).
- **`feedUpdateTimestamp` is now the timestamp used for freshness/monotonic
  checks**, not the envelope's own generation timestamp. A feed that hasn't
  actually updated this tick can carry an older `feedUpdateTimestamp` than
  the envelope wrapping it; using the envelope timestamp for staleness
  checks would accept a stale price inside a fresh-looking envelope. The
  per-feed timestamp is also checked to never exceed the envelope's own
  timestamp (a feed cannot have updated after the message that carries it
  was generated).
- Storage and treasury are validated as **separate accounts that need not be
  equal**: the real `Storage` account stores `treasury` as its own field
  (Anchor's `has_one = treasury` constraint on the real program), and this
  program reads that field directly (`storage[40..72]`, the correct byte
  offset past the 8-byte Anchor discriminator and 32-byte `top_authority`)
  rather than requiring `storage == treasury`.

## Testing

`programs/equinox/tests/pyth_oracle.rs` covers missing/wrong Ed25519
instruction, wrong instruction/signature index, wrong Pyth
program/storage/treasury, wrong feed/channel, unsupported exponent, invalid
price, excess confidence, stale/duplicate/future timestamp rejection, the
feed-vs-envelope timestamp ordering check, `Regular`/`OverNight`/`Closed`
session-to-`MarketMode` mapping, an out-of-range session value, and rejection
of both a fabricated non-Pyth payload and a wrong-magic payload.

`pinocchio::cpi::invoke_with_bounds` is a no-op off the SBF target (same
limitation as the MagicBlock CPIs -- see `docs/magicblock.md`), so these
tests cannot observe Pyth's own cryptographic signature/trusted-signer check
actually running; they are unit tests of this program's own validation and
parsing, not a runtime-verified live update. There is no official signed
fixture available without `PYTH_PRO_API_KEY`, so the "valid" fixture is
structurally well-formed and deterministic, not cryptographically signed.
Live authenticated verification remains unverified.

**Update:** `consume_oracle_update` now emits `OracleUpdated` and (when
the session-driven mode changed) `MarketSessionChanged` via the versioned
binary event ABI (`docs/events.md`). `OracleRejected`/`OracleStale`/
`OracleRecovered` remain unwired: every rejection path returns a program
error (the whole transaction fails, and any indexer already discards a
failed transaction's logs via `meta.err`, so a "rejected" event could
never actually reach an indexer), and no on-chain staleness-marking
instruction exists. The Pyth oracle keeper's real orchestration (lease,
durable dedup by timestamp+hash, submit, confirm) is now implemented in
`workers/src/keeper-jobs.ts::runPythKeeperTick` -- see `docs/transports.md`;
the actual signed-payload fetch and Ed25519+`ConsumeOracleUpdate`
instruction construction remain in `lib/server/pyth-keeper.ts`
(unchanged this session), injected into the keeper as a `PythUpdateSource`.
