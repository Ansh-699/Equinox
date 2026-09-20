import { MarketStream } from "./market-stream";
import type { MarketDefinition, MarketEvent, MarketEventKind } from "./types";
import { DeadLetterRepository, ExecutionStatusRepository, IndexerRepository, ProtocolRepository, type IndexedWrite } from './repositories';
import { keeperLeaseKey, runDurableKeeper } from './keepers';
import { SolanaL1Transport, MagicBlockErTransport } from './chain-transports';
import { decodeCustodyEvents } from './event-decoder';
import { AccountSnapshotFetcher } from './ingestion-pipeline';
import { MarketIndexer } from './indexer-service';
import { isWithdrawalDisplaySafe, reconcileMarketExecutionStatus } from './execution-status';
import { PrivateSessionRepository, publishSeatProjection, seatsAffectedByEvent } from './private-sessions';
import { classifyKeeperConfiguration, startKeeperRuntime } from './keeper-config';
import { resolveKeeperSigning } from './keeper-signer';
import { deriveTradingSessionAddress, verifyPrivyToken, verifyTradingSession, type PrivyVerifier } from './relay-auth';
import { LocalKeypairSigner } from './signer';
import { relaySessionTransaction, validateSessionTransaction } from './session-relayer';
import { ProtocolKeeperOrchestrator, type OrchestratorRunSummary } from './keeper-orchestrator';
import { STOCKSTREAM_PROGRAM_ID } from '../../clients/stockstream/src/constants';
import { deriveBookPageV3, deriveEventShardV3, deriveSeatShardV3, V3_BOOK_PAGES_PER_SIDE } from './v3-pdas';
import { fetchAuthoritativeV3Market, type V3MarketAggregate } from './v3-market-state';
import { address, getBase58Decoder } from '@solana/kit';

export { MarketStream };

/** Must equal lib/auth/e2e-test-mode.ts::E2E_TEST_TOKEN exactly -- a fixed,
 * public, non-secret string forwarded as-is by
 * app/api/relay/session/route.ts when the Next.js side's own e2e bypass
 * already accepted the request. Duplicated here (not imported) because the
 * Worker and the Next.js app are separately deployed bundles; this proves
 * nothing on its own without the E2E_TEST_MODE + non-production gate at
 * its one call site. */
const E2E_TEST_TOKEN = "e2e-test-token";

const eventKinds = new Set<MarketEventKind>(["book", "fill", "funding", "health", "oracle"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function v3JsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(v3JsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, v3JsonValue(entry)]));
  }
  return value;
}

/** Fetches a complete V3 execution bundle from one authoritative domain.
 * The caller supplies only the core PDA; every shard address is derived here
 * so a public read cannot silently substitute a page from another market. */
export async function fetchV3MarketSnapshot(
  env: Env,
  coreAddress: string,
  domain: 'l1' | 'er' = 'l1',
  fetcher: typeof fetch = fetch,
): Promise<V3MarketAggregate | null> {
  if (!env.SOLANA_RPC_URL) return null;
  try { address(coreAddress); } catch { return null; }
  const transport = domain === 'er'
    ? new MagicBlockErTransport(env.MAGICBLOCK_RPC_URL ?? env.SOLANA_RPC_URL, fetcher)
    : new SolanaL1Transport(env.SOLANA_RPC_URL, fetcher);
  const bookPages = await Promise.all(Array.from(
    { length: 2 * V3_BOOK_PAGES_PER_SIDE },
    (_, flat) => deriveBookPageV3(coreAddress, Math.floor(flat / V3_BOOK_PAGES_PER_SIDE), flat % V3_BOOK_PAGES_PER_SIDE),
  ));
  const seatShards = await Promise.all(Array.from({ length: 4 }, (_, shard) => deriveSeatShardV3(coreAddress, shard)));
  const eventShards = await Promise.all(Array.from({ length: 4 }, (_, shard) => deriveEventShardV3(coreAddress, shard)));
  return fetchAuthoritativeV3Market(transport, { core: coreAddress, bookPages, seatShards, eventShards }).catch(() => null);
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
      for (const event of events) {
        // A failed resnapshot (the authoritative-account fetch used to
        // repair a sequence gap) throws out of `ingest`. That failure must
        // not take down the rest of this tick -- other markets, and even
        // this market's other transactions, still deserve their own
        // attempt. The gap itself is untouched in D1 either way (`append`
        // never partially applies), so the next scheduled tick retries the
        // same resnapshot from the same cursor; skipping this one event
        // rather than aborting the whole tick cannot cause a later event to
        // be misapplied on top of an unresolved gap.
        try { await indexer.ingest(market.marketPda, event); } catch { continue; }
        eventsIngested += 1;
        // Best-effort private-projection push: never lets a decode/publish
        // failure for one event block ingesting the rest of the batch, and
        // never blocks on it -- the durable D1 event record above is
        // already the source of truth a client can resnapshot from.
        const discriminator = event.payload.discriminator;
        const payload = event.payload.payload;
        if (typeof discriminator === 'number' && typeof payload === 'string' && env.DB) {
          const sessions = new PrivateSessionRepository(env.DB);
          const stream = env.MARKET_STREAM!.getByName(definitionByPda.get(market.marketPda)?.symbol ?? market.marketPda);
          for (const seatIndex of seatsAffectedByEvent(discriminator, payload)) {
            await publishSeatProjection(l1, sessions, stream, market.marketPda, seatIndex, Date.now()).catch(() => {});
          }
        }
      }
    }
  }
  return { marketsPolled: markets.results.length, eventsIngested };
}

/** Backs `GET /v1/markets/:symbol/execution-status`. Extracted as its own
 * function (rather than inlined in the route handler) so tests can inject
 * a fake `fetcher` the same way `runIngestionTick` already does --
 * `SELF.fetch` integration tests cannot otherwise intercept this route's
 * outbound RPC calls to a real Solana/MagicBlock endpoint. Returns
 * `undefined` when no RPC endpoint is configured, `"not_found"` when the
 * market doesn't exist, or the real status payload otherwise. */
export async function fetchExecutionStatus(
  env: Env,
  symbol: string,
  stream: DurableObjectStub<MarketStream>,
  fetcher: typeof fetch = fetch,
): Promise<undefined | "not_found" | { status: string; sequences: unknown; error: string | null; withdrawalDisplaySafe: boolean }> {
  if (!env.SOLANA_RPC_URL || !env.DB) return undefined;
  const db = env.DB;
  const market = await db.prepare("SELECT market_pda AS marketPda FROM markets WHERE symbol = ?").bind(symbol).first<{ marketPda: string }>();
  if (!market) return "not_found";
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL, fetcher);
  const er = new MagicBlockErTransport(env.MAGICBLOCK_RPC_URL ?? env.SOLANA_RPC_URL, fetcher);
  const result = await reconcileMarketExecutionStatus(market.marketPda, l1, er, new ExecutionStatusRepository(db), Date.now());
  if (result.changed) {
    // Best-effort publish: the durable D1 record above is already the
    // source of truth regardless of whether this broadcast reaches any
    // currently-connected socket.
    await stream.publishExecutionStatus(result.state.status, isWithdrawalDisplaySafe(result.state)).catch(() => {});
  }
  return {
    status: result.state.status,
    sequences: result.state.sequences,
    error: result.state.error ?? null,
    withdrawalDisplaySafe: isWithdrawalDisplaySafe(result.state),
  };
}

/**
 * Priority 8, Section 11: the production scheduled keeper path. No
 * keeper-signing secret binding exists in this deployment's `Env` yet
 * (`signer.ts::createProductionSigner` requires one) -- `signer` is `null`
 * until one is provisioned, which safely degrades every job to
 * discovery/observation only (`ProtocolKeeperOrchestrator`'s own
 * documented fail-safe), never blocking ingestion, auth, or the public
 * API. Exported (like `runIngestionTick`) so tests can inject a fetcher.
 */
export async function runKeeperOrchestrationTick(env: Env, fetcher: typeof fetch = fetch): Promise<{ ran: boolean; reason?: string; summary?: OrchestratorRunSummary; signerState?: string }> {
  const { resolution, deps } = await startKeeperRuntime(env, fetcher);
  // Startup-state discipline: `observation-only`, `signer-invalid`, and
  // `configuration-blocked` all resolve to signer null inside
  // `startKeeperRuntime`, which degrades every job to
  // discovery/observation-only (the orchestrator's own documented
  // fail-safe) without blocking ingestion, auth, or the public API.
  if (resolution.state !== 'signer-ready' && resolution.state !== 'observation-only') {
    return { ran: false, reason: resolution.detail, signerState: resolution.state };
  }
  if (!deps) return { ran: false, reason: 'RPC endpoint not configured', signerState: resolution.state };
  const summary = await new ProtocolKeeperOrchestrator(deps).run();
  return { ran: true, summary, signerState: resolution.state };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "stockstream-market-api", environment: env.ENVIRONMENT });
    }

    // Local e2e diagnostics: which server-only bindings the runtime sees
    // (presence booleans only -- never values).
    if (request.method === "GET" && url.pathname === "/debug/env-presence") {
      return json({
        SOLANA_RPC_URL: !!env.SOLANA_RPC_URL,
        SOLANA_WS_URL: !!env.SOLANA_WS_URL,
        MAGIC_ROUTER_URL: !!env.MAGIC_ROUTER_URL,
        MAGICBLOCK_RPC_URL: !!env.MAGICBLOCK_RPC_URL,
        MAGICBLOCK_VALIDATOR: !!env.MAGICBLOCK_VALIDATOR,
        PYTH_PRO_API_KEY: !!env.PYTH_PRO_API_KEY,
        KEEPER_KEYPAIR_JSON: !!env.KEEPER_KEYPAIR_JSON,
        KEEPER_PUBLIC_KEY: !!env.KEEPER_PUBLIC_KEY,
        INGESTION_TOKEN: !!env.INGESTION_TOKEN,
        DB: !!env.DB,
      });
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
        keeperConfiguration: { ...classifyKeeperConfiguration(env), signerState: (await resolveKeeperSigning(env)).state },
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

    // V3 is an explicit shard bundle, not a V2 market-account fallback. The
    // core PDA is the only path parameter; all book/seat/event PDAs are
    // derived above and the aggregate is null when any authoritative shard
    // is missing or malformed.
    if (request.method === "GET" && parts[0] === "v1" && parts[1] === "v3" && parts[2] === "markets" && parts.length === 4) {
      const domain = url.searchParams.get("domain") === "er" ? "er" : "l1";
      const aggregate = await fetchV3MarketSnapshot(env, parts[3], domain);
      if (!aggregate) return json({ error: "v3_market_unavailable", domain }, 404);
      return json(v3JsonValue(aggregate));
    }

    if (request.method === "GET" && parts[0] === "v1" && parts[1] === "markets" && parts.length === 3) {
      const symbol = parts[2].toUpperCase();
      const market = await bindings(env).DB.prepare("SELECT symbol, instrument_id AS instrumentId, market_index AS marketIndex, market_pda AS marketPda, vault_pda AS vaultPda, status, oracle_feed_id AS oracleFeedId, session_policy AS sessionPolicy FROM markets WHERE symbol = ?").bind(symbol).first<MarketDefinition>();
      return market ? json(market) : json({ error: "market_not_found" }, 404);
    }

    // Priority 8, Section 15: the session-key relayer. Authenticated like
    // every operational route (bearer); rate limited per caller; validates
    // the session-key-signed transaction independently (fee payer = this
    // relayer, opcode allowlist), co-signs the exact same message bytes,
    // and submits through the domain the client picked. Never forwards a
    // transaction that failed validation.
    if (request.method === "POST" && url.pathname === "/v1/relay/session") {
      // Server-to-server auth: only this app's own Next.js backend may reach
      // this route at all (the browser never holds this credential). This
      // is independent of, and never a substitute for, the per-user Privy
      // check below -- it proves "a legitimate backend", not "which user".
      if (!env.RELAYER_SERVICE_TOKEN) return json({ error: "relayer_service_unconfigured" }, 503);
      if (request.headers.get("x-stockstream-relayer-service-token") !== env.RELAYER_SERVICE_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      // Per-user Privy auth: a fresh access token for the specific wallet
      // asserted below, verified against that wallet's real linked accounts
      // (never just the token's own claims). E2E_TEST_TOKEN is the exact
      // sentinel app/api/relay/session/route.ts forwards as-is when the
      // Next.js side's own e2e-test-mode bypass accepted the request
      // (lib/auth/e2e-test-mode.ts) -- double-gated the same way that side
      // gates it (an explicit flag AND never in production), so a stray
      // flag left set can never open a real bypass in production.
      const authHeader = request.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
      const privyToken = authHeader.slice(7);
      const e2eTestMode = env.E2E_TEST_MODE === "1" && env.ENVIRONMENT !== "production" && privyToken === E2E_TEST_TOKEN;
      if (!e2eTestMode && (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)) return json({ error: "privy_unconfigured" }, 503);
      const body = await request.json().catch(() => null) as {
        transactionBase64?: string;
        sessionSignerAddress?: string;
        ownerWallet?: string;
        expectedMarket?: string;
        domain?: string;
        clientRequestId?: string;
      } | null;
      if (!body?.transactionBase64 || !body.sessionSignerAddress || !body.ownerWallet || !body.expectedMarket) {
        return json({ error: "invalid_request" }, 400);
      }
      // Rate limits first: per-IP, per-wallet, per-signer -- before paying
      // for Privy verification or any RPC round trip.
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!await new ProtocolRepository(bindings(env).DB).allow(`relay:${ip}`, 30, 60_000, Date.now()))
        return json({ error: 'rate_limited' }, 429);
      if (!await new ProtocolRepository(bindings(env).DB).allow(`relay:${body.ownerWallet}`, 60, 60_000, Date.now()))
        return json({ error: 'rate_limited' }, 429);
      if (!await new ProtocolRepository(bindings(env).DB).allow(`relay:${body.sessionSignerAddress}`, 30, 60_000, Date.now()))
        return json({ error: 'rate_limited' }, 429);

      const relayerSigner = env.RELAYER_KEYPAIR_JSON
        ? new LocalKeypairSigner("relayer:fee-payer", env.RELAYER_KEYPAIR_JSON)
        : null;
      if (!relayerSigner) return json({ error: "relayer_signer_unconfigured" }, 503);
      const relayerAddress = getBase58Decoder().decode(await relayerSigner.publicKey());
      const transport = body.domain === "er"
        ? new MagicBlockErTransport(env.MAGIC_ROUTER_URL ?? env.MAGICBLOCK_RPC_URL ?? env.SOLANA_RPC_URL!, fetch)
        : new SolanaL1Transport(env.SOLANA_RPC_URL!, fetch);

      // Shape/signature validation FIRST: the canonical program address is
      // hardcoded here, never taken from the request body, and the
      // opcode/seatIndex/actionNonce below are extracted from the real,
      // cryptographically-signed instruction bytes -- not client claims.
      const shapeCheck = await validateSessionTransaction(
        { transactionBase64: body.transactionBase64, expectedProgramAddress: STOCKSTREAM_PROGRAM_ID, sessionSignerAddress: body.sessionSignerAddress },
        relayerAddress,
      );
      if (!shapeCheck.ok) return json({ error: shapeCheck.reason }, 400);

      // Per-user Privy auth (authoritative, fail-closed): the token must
      // verify AND the asserted wallet must be one Privy actually has
      // linked to this identity. In e2e test mode, this is a fixed,
      // non-secret synthetic identity that trivially "links" whatever
      // wallet the request claims -- exactly as permissive as the Next.js
      // side's own verifyE2eTestToken, and no more meaningful outside the
      // gate above.
      const privyResult = e2eTestMode
        ? await verifyPrivyToken(privyToken, "e2e", body.ownerWallet, {
            verify: async () => ({ user_id: "e2e-test-user", app_id: "e2e", solanaWallets: [body.ownerWallet!] }),
          })
        : await verifyPrivyToken(privyToken, env.PRIVY_APP_ID!, body.ownerWallet, {
            verify: async (token: string) => {
              const { PrivyClient } = await import("@privy-io/node");
              const client = new PrivyClient({ appId: env.PRIVY_APP_ID!, appSecret: env.PRIVY_APP_SECRET! });
              const verified = await client.utils().auth().verifyAccessToken(token);
              const user = await client.users()._get(verified.user_id);
              const solanaWallets = (user.linked_accounts ?? [])
                .filter((account): account is typeof account & { chain_type: "solana"; address: string } => "chain_type" in account && account.chain_type === "solana" && "address" in account)
                .map((account) => account.address);
              return { user_id: verified.user_id, app_id: verified.app_id, solanaWallets };
            },
          });
      if ("error" in privyResult) return json({ error: privyResult.error }, 401);

      // Authoritative on-chain chain: market bytes, the real TradingSession
      // PDA this relayer itself derives (never a client-supplied address),
      // and the session's own owner/signer/market/seat/expiry/revocation/
      // action-allowlist/nonce -- all checked against genuine RPC reads.
      const marketAccount = await transport.account(body.expectedMarket).catch(() => null);
      if (!marketAccount?.value?.data) return json({ error: "market_not_found" }, 404);
      const marketBytes = Uint8Array.from(atob(marketAccount.value.data[0]), (c) => c.charCodeAt(0));

      const sessionAddress = await deriveTradingSessionAddress(
        body.ownerWallet, body.expectedMarket, shapeCheck.seatIndex, body.sessionSignerAddress, STOCKSTREAM_PROGRAM_ID,
      );
      const sessionAccount = await transport.account(sessionAddress).catch(() => null);
      const sessionBytes = sessionAccount?.value?.data ? Uint8Array.from(atob(sessionAccount.value.data[0]), (c) => c.charCodeAt(0)) : null;

      const chainCheck = verifyTradingSession({
        marketBytes,
        sessionBytes,
        sessionAccountOwner: sessionAccount?.value?.owner ?? null,
        ownerWallet: body.ownerWallet,
        sessionSignerAddress: body.sessionSignerAddress,
        seatIndex: shapeCheck.seatIndex,
        marketPda: body.expectedMarket,
        programId: STOCKSTREAM_PROGRAM_ID,
        actionNonce: shapeCheck.actionNonce,
        opcode: shapeCheck.opcode,
        placeOrderFlags: shapeCheck.placeOrderFlags,
        now: new Date(),
      });
      if (!chainCheck.ok) return json({ error: chainCheck.reason }, 403);

      const outcome = await relaySessionTransaction(
        {
          transactionBase64: body.transactionBase64,
          expectedProgramAddress: STOCKSTREAM_PROGRAM_ID,
          sessionSignerAddress: body.sessionSignerAddress,
        },
        relayerSigner,
        transport,
      );
      if ("error" in outcome) return json({ error: outcome.error }, 400);
      return json({ accepted: true, signature: outcome.signature }, 202);
    }


    if (parts[0] === "v1" && parts[1] === "markets" && parts.length === 4) {
      const symbol = parts[2].toUpperCase();
      const action = parts[3];
      const stream = bindings(env).MARKET_STREAM.getByName(symbol);
      if (request.method === "GET" && action === "stream") return stream.fetch(request);
      if (request.method === "GET" && action === "snapshot") return stream.fetch(new Request("https://internal.invalid/snapshot"));
      if (request.method === "GET" && action === "execution-status") {
        const outcome = await fetchExecutionStatus(env, symbol, stream);
        if (!outcome) return json({ error: "rpc_not_configured" }, 503);
        if (outcome === "not_found") return json({ error: "market_not_found" }, 404);
        return json(outcome);
      }
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

      // The six keeper jobs (Pyth, session, funding, liquidation, cleanup,
      // commit). ProtocolKeeperOrchestrator owns its own internal lease
      // ("scheduler:keepers") and per-market/per-job idempotency, so this
      // is a direct call, not another runDurableKeeper wrapper -- double
      // -leasing the same tick would just contend with itself. A failure
      // here (e.g. a transport error before any market-level try/catch
      // applies) must never take down ingestion/cleanup, which already ran
      // above.
      await runKeeperOrchestrationTick(env).catch(() => {});
    }
  },
} satisfies ExportedHandler<Env>;
