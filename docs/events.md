# Equinox event ABI

Status: **program-side encoding/emission is unit tested and SBF compiled; not SBF-runtime or live verified.** Indexer-side decoding (TypeScript client SDK + Worker ingestion) is unit and Workers-runtime tested against golden vectors, not against a live cluster.

## Wire format

Every Equinox event is exactly one `sol_log_data` syscall call (`programs/equinox/src/events.rs`), carrying a fixed `EVENT_SIZE = 100` bytes: a 52-byte header followed by a fixed 48-byte payload whose layout depends on the header's discriminator.

```
offset  size  field
0       2     discriminator (u16 LE) -- see EventKind
2       1     abi_version (u8) -- currently 1
3       1     reserved
4       8     sequence (u64 LE) -- this market's own monotonic event counter
12      32    market (market account pubkey, raw bytes)
44      8     timestamp (u64 LE) -- protocol clock at the state transition
52      48    payload (discriminator-dependent, see below)
```

On the wire, this surfaces as a single `Program data: <base64>` line in `meta.logMessages`/a live `logsNotification`, decoded verbatim in `sol_log_data`'s Rust-native `&[&[u8]]` calling convention (this program only ever passes one field). This replaced an earlier, Priority-4-only, text-based `SS:<Kind> market=... seq=...` format (`Program log:` lines via `pinocchio_log`) -- the program no longer emits that format in any form.

Off the SBF target (`target_os != "solana"`), `log_bytes()` is a `core::hint::black_box` no-op, matching every other CPI/syscall boundary in this program (see `docs/magicblock.md`). This is why every Rust-side event test (`programs/equinox/tests/events.rs`) exercises `encode_event`/the payload builders directly -- the exact bytes that would be passed to the syscall -- rather than the syscall firing.

## Sequence semantics

`global_event_sequence` is the market's own **last used** sequence, not the next available one: every non-fill event advances it via `next_event_sequence`'s increment-then-assign. A fill inside `plan_seat_results` assigns its own sequence as `global_event_sequence + 1 + fill_index` for exactly this reason -- an earlier version used `+ fill_index` (0-indexed, treating the field as "next available"), which silently collided with whatever event had most recently advanced the same counter (a trailing `OrderPlaced`, a custody event). Fixed this session; see the `add complete versioned Equinox event ABI` and `wire OrderPlaced event and fix a real fill-sequence collision bug` commits, and the regression test `a_resting_orders_placed_event_never_collides_with_a_later_crossing_fills_sequence`.

The program-log record and the in-account `FillEvent` ring buffer record for the same fill always share one sequence number (`apply_scratch_results` reuses `value.sequence` from the ring buffer entry when emitting `OrderFilled`/`OrderPartiallyFilled`) -- they refer to the exact same logical fill, never two independently-numbered records of it.

Registry-level events (`ExchangeInitialized`, `StockInstrumentRegistered`, ...) predate the market-level sequence convention and currently use a placeholder sequence of `0` for all of them -- acceptable since these are governance-cadence, not high-frequency trading events; an indexer can order them by transaction signature + slot instead.

## Event kinds (61 total)

Grouped by numeric band, matching `EventKind` in `events.rs`:

| Band | Category | Count |
|---|---|---|
| 100-112 | Exchange and registry | 13 |
| 200-210 | Trader and orders | 11 |
| 300-307 | Positions and risk | 8 |
| 400-409 | Custody | 10 |
| 500-505 | Oracle | 6 |
| 600-607 | MagicBlock | 8 |
| 700-704 | Sessions | 5 |

### Wired into production handlers (50 of 61)

Every custody event (10/10); every registry/market-lifecycle event reachable given the instruction encoding (`ExchangeInitialized`, `StockInstrumentRegistered`, `StockInstrumentUpdated`, `StockInstrumentSuspended`, `PerpMarketCreated`, `MarketRiskUpdated`, `MarketPaused`, `MarketResumed`, `MarketCloseOnly`, `CorporateActionEntered`); the full order lifecycle (`OrderPlaced`, `OrderFilled`, `OrderPartiallyFilled`, `OrderCancelled`, `OrderReplaced`, `OrderExpired`, `InvalidOrderRemoved`, `CancelAllProgress`); seat lifecycle (`TraderSeatCreated`, `TraderSeatClosed`); risk (`PositionChanged`, `MarginChanged`, `FundingAccumulatorUpdated`, `FundingSettled` [taker-side only, see below], `LiquidationStarted`, `PositionLiquidated`); oracle (`OracleUpdated`, `MarketSessionChanged`); MagicBlock (`DelegationRequested`, `MarketDelegated`, `CommitRequested`, `CommitSequenceChanged`, `UndelegationRequested`, `RestorationPending`, `MarketRestored`); sessions (`TradingSessionAuthorized`, `TradingSessionLimitsUpdated`, `TradingSessionActionConsumed`, `TradingSessionRevoked`, `TradingSessionClosed`).

`FundingAccumulatorUpdated`/`FundingSettled` scope note: `FundingSettled` is only wired for the *taker* seat inside `place_order_core`'s end-of-function safe zone. Maker-side funding settlement happens inside `plan_seat_results`' fill-matching loop; wiring it there was deliberately deferred this session to avoid a third sequence-reservation change in that already-once-buggy code path under time pressure.

### Not reachable given current program logic (11 of 61)

Documented explicitly in `events.rs`/`handlers.rs`/`magicblock.rs`, not silently missing:

- **`SelfTradePrevented`** -- no self-trade-prevention logic exists in the matching engine (`book.rs`) at all.
- **`OracleRejected`** -- every code path that would emit it returns a program error, which aborts the whole transaction; any indexer already discards a failed transaction's logs wholesale via `meta.err`, so a "rejected" event would always be filtered before an indexer could ever see it. Architecturally unwireable as a *committed* event under this design.
- **`OracleStale` / `OracleRecovered`** -- no on-chain staleness-marking instruction exists; staleness detection today is purely a keeper-side/consumer-side check against `last_verified_oracle_timestamp`.
- **`DelegationErrorState`** -- Solana transactions are atomic; a failed delegation-program CPI aborts the whole instruction with no partial state to persist an "error state" into.
- **`ExchangeConfigUpdated`** -- no `UpdateExchangeConfig` instruction exists in this program.
- **`CorporateActionResolved` / `MarketClosed`** -- `instruction.rs::decode` collapses `PAUSE_MARKET`/`CLOSE_MARKET` to the same mode value, and `RESUME_MARKET`/`RESOLVE_CORPORATE_ACTION` to the same mode value, before `transition_market` ever runs; the handler genuinely cannot distinguish which opcode was actually sent.
- **`BankruptcyRecorded` / `InsuranceApplied`** -- no automatic bankruptcy-detection or insurance-fund-application logic exists inside `liquidate`; the only insurance-fund-touching instructions today are the manual, governance-triggered `record_bad_debt`/`resolve_bad_debt` (which already emit `BadDebtRecorded`/`BadDebtResolved`/`InsuranceFundChanged`, a related but distinct mechanism).
- **`TradingStatusChanged`** -- redundant with `MarketSessionChanged` for every oracle-driven mode transition in this implementation; not duplicated.

## Payload shapes

13 fixed 48-byte payload builders in `events.rs`, each documented with its exact byte offsets in its own doc comment: `payload_empty`, `payload_seat`, `payload_seat_amount`, `payload_order`, `payload_fill`, `payload_position`, `payload_funding`, `payload_liquidation`, `payload_oracle`, `payload_delegation`, `payload_session`, `payload_registry`, `payload_reconciliation`. `NO_SEAT = u16::MAX` is the sentinel for a market-level (non-seat-specific) event using a seat-shaped payload.

The TypeScript client SDK (`clients/equinox/src/index.ts`) mirrors every payload byte-for-byte (`decodeEquinoxEvent` + one `decode*Payload` function per shape); the Worker's ingestion-path decoder (`workers/src/event-decoder.ts`) reimplements the same envelope decode (Workers-runtime-compatible, no Node `Buffer`) and buckets every discriminator into the pre-existing, coarser `MarketEventKind` taxonomy (`book`/`fill`/`funding`/`custody`/`oracle`/`health`) so downstream indexer/stream code needs no changes. An unrecognized discriminator is preserved as `Unknown(<n>)` by both decoders rather than dropped, so a future ABI addition doesn't silently blind an older indexer.

## Testing

- `programs/equinox/tests/events.rs`: header/payload byte-layout golden vectors, discriminator uniqueness across all 61 kinds, sequence/market distinguishability, and per-newly-wired-kind golden vectors.
- `clients/equinox/src/index.test.ts`: matching TypeScript golden vectors for the same discriminators/payloads.
- `workers/src/event-decoder.test.ts`: binary decode via a real mock JSON-RPC HTTP handler, bucket-kind mapping, unrecognized-discriminator preservation, failed-transaction log discarding.
- `programs/equinox/tests/account_settlement.rs`: handler-level (not just codec-level) coverage -- `Liquidate` and `CancelAll` invoked through `process_instruction`, a dedicated fill-sequence-collision regression test, and an event-sequence-overflow-at-`u64::MAX` rejection test.
