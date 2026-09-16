# Worker

The Worker exposes market registry, ingestion, snapshot/stream, and keeper
health endpoints. D1 stores durable market projections and keeper state;
Durable Objects (`MarketStream`, one per market) fan out sequence-bearing
public deltas over WebSocket and, separately, verified private per-trader
deltas. Secrets are bindings, never response fields.

**Status correction**: the previous wording here ("dead-letter processing
use[s] the projection tables added in migration 0003") was aspirational,
not true -- the `dead_letters` table existed but no code read or wrote it.
Priority 5/6 (2026-09-17) made every claim below actually real and tested.

## Transports (Priority 5, Section 2)

`chain-transports.ts` provides concrete HTTP JSON-RPC transports
(`SolanaL1Transport`, `MagicBlockErTransport`) for `getAccountInfo`,
`getSignaturesForAddress`, `getTransaction`, `getSignatureStatuses`.
`ws-transport.ts`'s `ChainWebSocketTransport` provides the real Solana
pubsub WebSocket protocol (`logsSubscribe`/`accountSubscribe`/
`signatureSubscribe` and their `*Unsubscribe` counterparts) with bounded
exponential reconnect, subscription restoration after reconnect, stale-
connection detection via an idle-message heartbeat probe, malformed-message
and RPC-error handling, and graceful shutdown. One instance per chain
(`source: 'l1' | 'er'`), each carrying its own endpoint identity -- L1 and
ER traffic are never multiplexed over the same connection or mistaken for
each other. 12 tests in `ws-transport.test.ts` using a fully in-memory mock
socket (no real networking).

The WebSocket transport is not yet wired into the scheduled worker: a
persistent subscription cannot outlive a single stateless `scheduled`
invocation (only a Durable-Object-hosted connection could keep one alive
across ticks, which has not been built). The real, currently-wired
ingestion path instead polls via the HTTP transport (see below).

## Event decoding (Section 3)

`event-decoder.ts::decodeCustodyLogMessages`/`decodeCustodyEvents` decode
the `SS:<Kind> market=... seq=...` custody program-log lines
`handlers::log_custody_event` emits (`docs/custody.md`) into typed
`MarketEvent`s, from either a live `logsNotification`'s `logs` array or a
`getTransaction` result's `meta.logMessages`. A failed transaction's logs
are skipped entirely (rolled-back state is never an event); unrecognized
lines are skipped, never thrown. Only custody events are decoded today --
order/fill/funding/liquidation/oracle/delegation/session events are not
yet logged by the Rust program at all, so there is nothing yet to decode
for them (a prerequisite gap in the program, not the indexer).

## Durable ingestion pipeline (Sections 3-5)

`ingestion-pipeline.ts::ingestLogsNotification` connects a live
`logsNotification` straight into `indexer-service.ts::MarketIndexer.ingest`
(already-real durable D1 ordered ingestion: `repositories.ts::IndexerRepository`
tracks a per-market-per-domain cursor, rejects duplicates by event ID, and
detects any non-contiguous sequence as a gap). `ingestion-pipeline.ts::AccountSnapshotFetcher`
is the first concrete `AuthoritativeSnapshotFetcher`: on a detected gap, it
fetches the real market account via the HTTP transport and decodes its
`mode` and `global_event_sequence` to repair both the D1 cursor and the
`MarketStream` Durable Object's projection, tested end to end in
`ingestion-pipeline.test.ts` (real D1 + real DO, not fakes).

`index.ts::runIngestionTick` (Section 8) is the scheduled worker's real
ingestion tick: for every registered market, it polls recent L1 signatures,
decodes any new custody events, and ingests them through the same pipeline.
Runs as its own fenced, idempotent `runDurableKeeper` lease
(`keeperLeaseKey('ingestion')`), independent of the cleanup keeper -- a
slow or failed tick of either kind can never block the other.

## ER/L1 execution-status reconciliation (Section 6)

`execution-status.ts` models a market's delegation lifecycle
(`l1_only -> delegating -> er_active -> er_accepted -> commit_scheduled ->
commit_observed_on_l1 -> commit_finalized -> undelegating ->
restoration_pending -> restored`, with `reconciliation_error` reachable
from any state on a conflicting/regressed sequence) as pure, tested state
transitions. This is an **indexer-side, informational** model only -- it
governs what the UI/API should *display*, never the actual withdrawal
security boundary, which is enforced entirely on-chain by the Rust
program's own `DelegationStatus`/`l1_withdrawals_allowed()`
(`docs/custody.md`). It is not yet wired to live commit-schedule/
commit-observation on-chain data (that would require decoding real
delegation-program/magic-program account state, not yet built). 9 tests.

## Private trader projections (Section 7)

Architecture choice: **authenticated filtered private subscriptions over
the existing `MarketStream` Durable Object**, not a separate per-user DO
class -- see `private-sessions.ts`'s module doc for the full reasoning.
`PrivateSessionRepository` (migration `0005_private_sessions.sql`) issues
and verifies opaque, SHA-256-hashed session tokens bound to
`(wallet, marketPda, seatIndex)`; `issuePrivateProjectionToken` refuses to
issue one unless the asserted wallet is independently confirmed, via a
real on-chain account read, to actually own that seat
(`seatOwner`, decoding `TraderSeat.trader` at its packed byte offset).
`MarketStream.fetch` verifies a `?token=&market=` pair on WebSocket
upgrade and rejects the connection outright (401/400) rather than silently
downgrading to public-only; `publishPrivate(wallet, seatIndex, payload)`
delivers only to the matching verified socket(s), on a message shape
(`{type:'private', ...}`) the public `broadcast()` path never produces.
15 tests across `private-sessions.test.ts` and `market-stream.test.ts`,
including that the public stream never contains a private field.

Trust boundary: this Worker does not verify a Privy JWT itself (that
already happens in the Next.js app, `lib/auth/session.ts`); the caller of
`issuePrivateProjectionToken` is assumed to have already authenticated the
caller and is asserting `wallet` truthfully over some service-to-service
channel not built here.

## Keepers, leases, retry, dead-letter (Priority 6)

`keepers.ts::runDurableKeeper` (pre-existing, real): D1-fenced lease
acquisition plus idempotent operation tracking, so an expired keeper
instance can never write after another has taken the lease over, and a
retried call with the same idempotency key replays the prior success
rather than re-executing. `runDurableKeeperWithDeadLetter` (new) adds a
durable dead-letter record on failure and clears it on a later success of
the same job identity, giving up (pushing the retry far into the future,
not deleting the record) after a configurable attempt count --
`repositories.ts::DeadLetterRepository` is the first code to ever read or
write the `dead_letters` table. `GET /v1/health/keepers` (authorized)
reports due dead-letter entries and current lease state. 5 dead-letter
tests plus 1 endpoint test.

**Still not built**: any keeper that *submits* a signed transaction (Pyth
price push, MagicBlock commit scheduling, funding-rate settlement) --
those need wallet/key-management infrastructure this Worker does not have
yet. The generic fencing/idempotency/retry/dead-letter machinery above is
ready for them; the actual signing keeper jobs are the next real blocker.

## Testing

66 Vitest tests, run against the real `@cloudflare/vitest-pool-workers`
Miniflare environment (real D1 migrations via `applyD1Migrations`, real
`MarketStream` Durable Object via `env.MARKET_STREAM.getByName(...)`, real
`SELF.fetch`) -- not plain JavaScript fakes standing in for Cloudflare
primitives.
