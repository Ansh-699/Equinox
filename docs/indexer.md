# Indexer

Indexing is per market and per domain (`l1` or `er`). Cursors advance only on
contiguous sequences; duplicates are idempotent and gaps require snapshot
resynchronization. ER state is never treated as L1 finality, and indexer data
is never an oracle or risk authority.

## Priority 5 status (2026-09-17)

Real, real-cluster-protocol-accurate WebSocket subscription transports
now exist (`ws-transport.ts::ChainWebSocketTransport`: `logsSubscribe`/
`accountSubscribe`/`signatureSubscribe`, bounded reconnect, subscription
restoration, stale-connection detection, graceful shutdown), the custody
event decoder is wired into the durable D1 ingestion pipeline end to end
(`ingestion-pipeline.ts`, with a concrete `AccountSnapshotFetcher` backing
gap-triggered resnapshot -- proven with a real D1 + real `MarketStream`
Durable Object integration test, not fakes), the scheduled worker actually
runs an ingestion tick now (`index.ts::runIngestionTick`, its own fenced
keeper lease, independent of cleanup), a foundational ER/L1
execution-status reconciliation model exists (`execution-status.ts`), and
private trader projections are access-controlled end to end
(`private-sessions.ts` + `market-stream.ts`'s verified private channel).
Full detail in `docs/worker.md`, `docs/magicblock.md`, and
`docs/security.md`.

**Update:** the program now emits a complete 61-kind versioned binary
event ABI (`docs/events.md`); both the TypeScript client SDK decoder and
this Worker's `event-decoder.ts` decode it across every transport path
(live `logsNotification`, historical `getTransaction` backfill). ER/L1
reconciliation is now wired to real on-chain reads (`execution-status.ts`,
see `docs/magicblock.md`). All six keeper jobs now exist
(`keeper-jobs.ts`, see `docs/transports.md`) with lease/idempotency/
transport/confirmation wiring. 155 Worker tests total (up from 66).
