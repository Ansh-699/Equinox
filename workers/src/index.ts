import { MarketStream } from "./market-stream";
import type { MarketDefinition, MarketEvent, MarketEventKind } from "./types";
import { ProtocolRepository } from './repositories';

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

async function ingestEvent(event: MarketEvent, env: Env): Promise<void> {
  const { DB, MARKET_STREAM } = bindings(env);
  const result = await DB.prepare(
    `INSERT OR IGNORE INTO market_events (id, symbol, kind, slot, payload, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.id, event.symbol, event.kind, event.slot ?? null, JSON.stringify(event.payload), event.observedAt)
    .run();

  if (result.meta.changes === 1) await MARKET_STREAM.getByName(event.symbol).publish(event);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "stockstream-market-api", environment: env.ENVIRONMENT });
    }

    if (request.method === "POST" && url.pathname === "/v1/ingest/market-event") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      if (!await new ProtocolRepository(bindings(env).DB).allow('ingestion', 1000, 60_000, Date.now()))
        return json({ error: 'rate_limited' }, 429);
      const event = asMarketEvent(await request.json().catch(() => null));
      if (!event) return json({ error: "invalid_market_event" }, 400);
      await ingestEvent(event, env);
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
    await env.DB.prepare("DELETE FROM indexed_events WHERE observed_at < ?").bind(Date.now() - 90 * 24 * 60 * 60 * 1000).run();
    await new ProtocolRepository(env.DB).cleanup(Date.now());
  },
} satisfies ExportedHandler<Env>;
