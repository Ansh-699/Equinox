# Indexer

Indexing is per market and per domain (`l1` or `er`). Cursors advance only on
contiguous sequences; duplicates are idempotent and gaps require snapshot
resynchronization. ER state is never treated as L1 finality, and indexer data
is never an oracle or risk authority.

## Priority 5 status (2026-09-16, in progress)

Real, already implemented before this pass: `workers/src/chain-transports.ts`
(concrete JSON-RPC HTTP transports for both Solana L1 and the MagicBlock ER
-- `getAccountInfo`, `getSignaturesForAddress`, `getTransaction`,
`getSignatureStatuses`), `workers/src/repositories.ts::IndexerRepository`
(durable D1 cursor per market/domain, event dedup by ID, gap detection,
snapshot replacement), `workers/src/indexer-service.ts::MarketIndexer`
(ordered ingestion that resnapshots from an authoritative fetcher on any
gap, never fills one from the event stream itself), `workers/src/market-stream.ts`
(a Durable-Object-backed public WebSocket market stream with its own
per-connection backpressure and resynchronization signaling), and
`workers/src/keepers.ts` (lease-fenced, idempotent keeper execution with
exponential retry backoff and a durable failed-operation record acting as a
dead-letter store).

Added this pass: `workers/src/event-decoder.ts::decodeCustodyEvents` --
real decoding of custody program logs (the `SS:<Kind> market=... seq=...
...` lines `handlers::log_custody_event` emits, see `docs/custody.md`) out
of a raw `getTransaction` result into typed `MarketEvent`s, closing what was
previously a real gap: the transports returned raw bytes/JSON and nothing
converted that into the events `MarketIndexer`/`IndexerRepository` consume.
A failed transaction's logs are skipped entirely (rolled-back state must
never become an event); unrecognized or malformed log lines are skipped,
never thrown, so one bad line can't abort a whole ingestion batch. Seven new
Vitest tests in `workers/src/event-decoder.test.ts`.

**Still remaining, honestly not yet done:** a WebSocket *subscription*
transport for either L1 or the ER (only HTTP JSON-RPC polling exists);
the scheduled-worker wiring that actually calls
transports -> `decodeCustodyEvents` -> `MarketIndexer.ingest` in a loop (the
pieces exist and are tested independently, but are not yet connected end to
end in `workers/src/index.ts`'s `scheduled` handler, which currently only
runs the cleanup keeper); and private, per-trader projections (`MarketStream`
broadcasts identically to every connected socket -- there is no per-trader
filtering of position/order/balance data separate from the public market
stream). Priority 5 is implementation-begun, not complete.
