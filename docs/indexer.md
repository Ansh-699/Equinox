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

**Still remaining, honestly not yet done:** the WebSocket transport is not
wired into the scheduled ingestion loop (a persistent subscription can't
outlive one stateless `scheduled` invocation without a Durable-Object-
hosted connection, which doesn't exist yet -- the currently-wired path
polls over HTTP instead); only custody events are decoded (order/fill/
funding/liquidation/oracle/delegation/session events aren't logged by the
Rust program yet, so there's nothing to decode for them); ER/L1
reconciliation is not wired to live on-chain commit-observation data; and
no keeper yet *submits* a signed transaction (Pyth price push, MagicBlock
commit scheduling, funding settlement) -- that needs wallet/key
infrastructure this Worker doesn't have. 66 Worker tests total.
