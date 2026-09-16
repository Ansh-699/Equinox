import { MarketStream } from "./market-stream";
import type { MarketDefinition, MarketEvent, MarketEventKind } from "./types";
import { DeadLetterRepository, IndexerRepository, ProtocolRepository, type IndexedWrite } from './repositories';
import { keeperLeaseKey, runDurableKeeper } from './keepers';
import { SolanaL1Transport, MagicBlockErTransport } from './chain-transports';
import { decodeCustodyEvents } from './event-decoder';
import { AccountSnapshotFetcher } from './ingestion-pipeline';
import { MarketIndexer } from './indexer-service';

export { MarketStream };

const eventKinds = new Set<MarketEventKind>(["book", "fill", "funding", "health", "oracle"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("Authorization");
  return Boolean(env.INGESTION_TOKEN) && token === `Bearer ${env.INGESTION_TOKEN}`;
}

function asMarketEvent(input: unknown): MarketEvent | null {
  if (
    !input ||
    typeof input !== "object" ||
    !("id" in input) ||
    !("symbol" in input) ||
    !("kind" in input) ||
    !("payload" in input) ||
    typeof input.id !== "string" ||
    typeof input.symbol !== "string" ||
    typeof input.kind !== "string" ||
    !eventKinds.has(input.kind as MarketEventKind) ||
    !input.payload ||
    typeof input.payload !== "object"
  ) {
    return null;
  }

  const record = input as Record<string, unknown>;
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) <= 0 ||
      (record.domain !== 'l1' && record.domain !== 'er')) return null;
  return {
    id: input.id,
    symbol: input.symbol.toUpperCase(),
    kind: input.kind as MarketEventKind,
    slot: "slot" in input && typeof input.slot === "number" ? input.slot : undefined,
    payload: input.payload as Record<string, unknown>,
    observedAt: "observedAt" in input && typeof input.observedAt === "number" ? input.observedAt : Date.now(),
    sequence: "sequence" in input && typeof input.sequence === "number" ? input.sequence : undefined,
    domain: record.domain === "l1" || record.domain === "er" ? record.domain : undefined,
  };
}

function bindings(env: Env): { DB: D1Database; MARKET_STREAM: DurableObjectNamespace<MarketStream> } {
  if (!env.DB || !env.MARKET_STREAM) throw new Error("Required storage bindings are unavailable");
  return { DB: env.DB, MARKET_STREAM: env.MARKET_STREAM };
}

async function ingestEvent(event: MarketEvent, env: Env): Promise<IndexedWrite> {
  const { DB, MARKET_STREAM } = bindings(env);
  if (!event.domain || event.sequence === undefined) throw new Error('sequenced domain event required');
  const market = await DB.prepare('SELECT market_pda AS marketPda FROM markets WHERE symbol=?').bind(event.symbol).first<{ marketPda: string }>();
  if (!market?.marketPda) throw new Error('market_not_registered');
  const indexed = await new IndexerRepository(DB).append(
    market.marketPda, event.domain, event.sequence, event.slot ?? 0, event.id, event, event.observedAt,
  );
  if (indexed.kind !== 'applied') return indexed;
  const result = await DB.prepare(
    `INSERT OR IGNORE INTO market_events (id, symbol, kind, slot, payload, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.id, event.symbol, event.kind, event.slot ?? null, JSON.stringify(event.payload), event.observedAt)
    .run();

  if (result.meta.changes === 1) await MARKET_STREAM.getByName(event.symbol).publish(event);
  return indexed;
}

function asMarketDefinition(input: unknown): MarketDefinition | null {
  if (
    !input ||
    typeof input !== "object" ||
    !("symbol" in input) ||
    !("marketIndex" in input) ||
    !("instrumentId" in input) ||
    !("marketPda" in input) ||
    !("vaultPda" in input) ||
    !("sessionPolicy" in input) ||
    !("status" in input) ||
    !("oracleFeedId" in input) ||
    typeof input.symbol !== "string" ||
    typeof input.marketIndex !== "number" ||
    typeof input.instrumentId !== "string" ||
    typeof input.marketPda !== "string" ||
    typeof input.vaultPda !== "string" ||
    typeof input.oracleFeedId !== "string" ||
    (input.status !== "active" && input.status !== "paused" && input.status !== "restricted") ||
    (input.sessionPolicy !== "regular" && input.sessionPolicy !== "extended" && input.sessionPolicy !== "close-only")
  ) return null;

  return {
    symbol: input.symbol.toUpperCase(),
    instrumentId: input.instrumentId,
    marketIndex: input.marketIndex,
    marketPda: input.marketPda,
    vaultPda: input.vaultPda,
    status: input.status,
    oracleFeedId: input.oracleFeedId,
    sessionPolicy: input.sessionPolicy,
  };
}

/**
 * Priority 5, Section 8: the scheduled worker's real (not merely
 * cleanup-only) ingestion tick. A persistent WebSocket subscription
 * cannot outlive a single `scheduled` invocation in a stateless Worker
 * (only a Durable Object connection can) -- see `ws-transport.ts`'s doc
 * comment -- so this tick polls each registered market's recent L1
 * signatures via the real HTTP transport instead, decodes any custody
 * events out of the ones it hasn't already indexed, and ingests them
 * through the same durable D1 + gap-resnapshot pipeline the (still
 * separate, not-yet-wired) WebSocket path would use. Bounded to whatever
 * `getSignaturesForAddress` returns per market per tick (its own server-
 * side `limit`), not unbounded history replay.
 */
export async function runIngestionTick(env: Env, fetcher: typeof fetch = fetch): Promise<{ marketsPolled: number; eventsIngested: number }> {
  if (!env.DB || !env.MARKET_STREAM || !env.SOLANA_RPC_URL) return { marketsPolled: 0, eventsIngested: 0 };
  const db = env.DB;
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL, fetcher);
  const er = new MagicBlockErTransport(env.MAGICBLOCK_RPC_URL ?? env.SOLANA_RPC_URL, fetcher);
  const markets = await db
    .prepare('SELECT symbol, instrument_id AS instrumentId, market_index AS marketIndex, market_pda AS marketPda, vault_pda AS vaultPda, status, oracle_feed_id AS oracleFeedId, session_policy AS sessionPolicy FROM markets')
    .all<MarketDefinition>();
  const definitionByPda = new Map(markets.results.map((market) => [market.marketPda, market]));
  const indexerRepository = new IndexerRepository(db);
  const indexer = new MarketIndexer(
    indexerRepository,
    new AccountSnapshotFetcher(l1, er, (pda) => {
      const definition = definitionByPda.get(pda);
      if (!definition) throw new Error(`unregistered market: ${pda}`);
      return definition;
    }),
    (marketPda) => env.MARKET_STREAM!.getByName(definitionByPda.get(marketPda)?.symbol ?? marketPda),
  );
  let eventsIngested = 0;
  for (const market of markets.results) {
    const cursor = await indexerRepository.cursor(market.marketPda, 'l1');
    let signatures: Array<{ signature: string; slot: number; err: unknown }>;
    try { signatures = await l1.signatures(market.marketPda); } catch { continue; }
    // The RPC returns newest-first; ingest oldest-first so sequence
    // ordering has a chance of being contiguous instead of an immediate
    // gap on every single tick.
    for (const entry of [...signatures].reverse()) {
      if (entry.err || (cursor && entry.slot <= cursor.slot)) continue;
      let transaction: unknown;
      try { transaction = await l1.transaction(entry.signature); } catch { continue; }
      const events = decodeCustodyEvents(transaction as Parameters<typeof decodeCustodyEvents>[0], 'l1', Date.now());
      for (const event of events) { await indexer.ingest(market.marketPda, event); eventsIngested += 1; }
    }
  }
  return { marketsPolled: markets.results.length, eventsIngested };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "stockstream-market-api", environment: env.ENVIRONMENT });
    }

    // Priority 6: keeper health/metrics. Authorized like the other
    // operational routes -- due dead-letter counts and per-kind lease
    // freshness are operational detail, not public information.
    if (request.method === "GET" && url.pathname === "/v1/health/keepers") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const { DB } = bindings(env);
      const now = Date.now();
      const due = await new DeadLetterRepository(DB).due(now, 100);
      const leases = await DB.prepare(
        "SELECT lease_key AS leaseKey, holder, fence, expires_at AS expiresAt FROM keeper_leases ORDER BY lease_key",
      ).all<{ leaseKey: string; holder: string; fence: number; expiresAt: number }>();
      return json({
        checkedAt: now,
        deadLetters: { due: due.length, entries: due.map((d) => ({ id: d.id, operation: d.operation, attempts: d.attempts, error: d.error })) },
        leases: leases.results.map((lease) => ({ ...lease, active: lease.expiresAt > now })),
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/ingest/market-event") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (!await new ProtocolRepository(bindings(env).DB).allow('ingestion', 1000, 60_000, Date.now()))
        return json({ error: 'rate_limited' }, 429);
      const event = asMarketEvent(await request.json().catch(() => null));
      if (!event) return json({ error: "invalid_market_event" }, 400);
      let indexed: IndexedWrite;
      try { indexed = await ingestEvent(event, env); } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'index_failed' }, 409);
      }
      if (indexed.kind === 'gap') return json({ error: 'sequence_gap', expected: indexed.expected }, 409);
      return json({ accepted: true }, 202);
    }

    if (request.method === "POST" && url.pathname === "/v1/ingest/market") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const market = asMarketDefinition(await request.json().catch(() => null));
      if (!market) return json({ error: "invalid_market" }, 400);
      await bindings(env).DB.prepare(
        `INSERT INTO markets (symbol, instrument_id, market_index, market_pda, vault_pda, status, oracle_feed_id, session_policy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           instrument_id = excluded.instrument_id,
           market_index = excluded.market_index,
           market_pda = excluded.market_pda,
           vault_pda = excluded.vault_pda,
           status = excluded.status,
           oracle_feed_id = excluded.oracle_feed_id,
           session_policy = excluded.session_policy,
           updated_at = excluded.updated_at`,
      ).bind(market.symbol, market.instrumentId, market.marketIndex, market.marketPda, market.vaultPda, market.status, market.oracleFeedId, market.sessionPolicy, Date.now()).run();
      return json({ accepted: true }, 202);
    }

    if (request.method === "GET" && url.pathname === "/v1/markets") {
      const result = await bindings(env).DB.prepare("SELECT symbol, instrument_id AS instrumentId, market_index AS marketIndex, market_pda AS marketPda, vault_pda AS vaultPda, status, oracle_feed_id AS oracleFeedId, session_policy AS sessionPolicy FROM markets ORDER BY market_index").all<MarketDefinition>();
      return json({ markets: result.results });
    }

    if (request.method === "GET" && parts[0] === "v1" && parts[1] === "markets" && parts.length === 3) {
      const symbol = parts[2].toUpperCase();
      const market = await bindings(env).DB.prepare("SELECT symbol, instrument_id AS instrumentId, market_index AS marketIndex, market_pda AS marketPda, vault_pda AS vaultPda, status, oracle_feed_id AS oracleFeedId, session_policy AS sessionPolicy FROM markets WHERE symbol = ?").bind(symbol).first<MarketDefinition>();
      return market ? json(market) : json({ error: "market_not_found" }, 404);
    }

    if (parts[0] === "v1" && parts[1] === "markets" && parts.length === 4) {
      const symbol = parts[2].toUpperCase();
      const action = parts[3];
      const stream = bindings(env).MARKET_STREAM.getByName(symbol);
      if (request.method === "GET" && action === "stream") return stream.fetch(request);
      if (request.method === "GET" && action === "snapshot") return stream.fetch(new Request("https://internal.invalid/snapshot"));
    }

    return json({ error: "not_found" }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!env.DB) return;
    const db = env.DB;
    const now = Date.now();
    const repository = new ProtocolRepository(db);
    // Ingestion and cleanup are two independent fenced keepers, each with
    // its own lease: a slow or failed ingestion tick must never block
    // cleanup (or vice versa), and an expired keeper of either kind can
    // never write after another instance has taken its lease over.
    await runDurableKeeper(repository, {
      leaseKey: keeperLeaseKey('cleanup'), holder: 'scheduled-worker',
      idempotencyKey: `cleanup:${Math.floor(now / 60_000)}`,
      requestHash: `cleanup:${Math.floor(now / 60_000)}`,
      now, leaseTtlMs: 55_000, idempotencyTtlMs: 24 * 60 * 60 * 1000,
      work: async () => {
        await db.prepare("DELETE FROM indexed_events WHERE observed_at < ?").bind(now - 90 * 24 * 60 * 60 * 1000).run();
        await repository.cleanup(now);
        return { cleanedAt: now };
      },
    });
    if (env.SOLANA_RPC_URL) {
      await runDurableKeeper(repository, {
        leaseKey: keeperLeaseKey('ingestion'), holder: 'scheduled-worker',
        idempotencyKey: `ingest:${Math.floor(now / 15_000)}`,
        requestHash: `ingest:${Math.floor(now / 15_000)}`,
        now, leaseTtlMs: 55_000, idempotencyTtlMs: 5 * 60_000,
        work: () => runIngestionTick(env),
      }).catch(() => {}); // a lease/idempotency conflict here just means another instance is already ticking; never let it fail the whole scheduled invocation.
    }
  },
} satisfies ExportedHandler<Env>;
