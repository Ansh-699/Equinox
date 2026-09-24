import { applyCors, preflight } from "./cors";
import type { RefreshResult } from "./oracle-refresh";
import { runOracleRefresh } from "./oracle-runner";
import { fetchCandles, parseCandleQuery } from "./candles";
import { signAndSerializeTransaction } from "./transactions";
import { CLAIM_INTERVAL_MS, FAUCET_TOKENS, faucetInstructions, SOL_TOP_UP_BELOW, verifyFaucetSignature } from "./faucet";
import deployment from "../../config/stockstream-deployment.json";
import { MarketStream } from "./market-stream";
import type { MarketDefinition, MarketEvent } from "./types";
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
import { handleV3MarketRoute } from './v3-routes';
import { fetchPreIpoTokens } from './pre-ipo';
import { getBase58Decoder } from '@solana/kit';
import { deriveSeatShardV3 } from './v3-pdas';
import { decodeV3Core, decodeV3SeatShard } from './v3-market-state';
import { asMarketDefinition, asMarketEvent, isAuthorized, json } from './route-inputs';

export { fetchV3MarketSnapshot } from './v3-routes';

export { MarketStream };

/** Must equal lib/auth/e2e-test-mode.ts::E2E_TEST_TOKEN exactly -- a fixed,
 * public, non-secret string forwarded as-is by
 * app/api/relay/session/route.ts when the Next.js side's own e2e bypass
 * already accepted the request. Duplicated here (not imported) because the
 * Worker and the Next.js app are separately deployed bundles; this proves
 * nothing on its own without the E2E_TEST_MODE + non-production gate at
 * its one call site. */
const E2E_TEST_TOKEN = "e2e-test-token";

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

/** Verifies a Privy access token and returns the user's linked Solana wallets. */
function privyVerifier(env: Env): PrivyVerifier {
  return {
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
  };
}

/** The faucet keeps this much SOL (0.2) for its own fees before giving any away. */
const FAUCET_KEEPER_SOL_FLOOR = 200_000_000n;

/** Most an operator mint may issue at once: 10M test tokens (6 decimals). */
const OPERATOR_MINT_MAX = 10_000_000_000_000n;

/** POST /v1/operator/mint: operator-only (ingestion bearer) test-collateral
 * mint for market-maker seats. Test collateral only; the keeper is its mint authority. */
async function operatorMint(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null) as { wallet?: unknown; tokens?: unknown } | null;
  const wallet = typeof body?.wallet === "string" ? body.wallet : "";
  const tokens = typeof body?.tokens === "string" && /^\d+$/.test(body.tokens) ? BigInt(body.tokens) : 0n;
  if (!wallet || tokens <= 0n || tokens > OPERATOR_MINT_MAX) return json({ error: "wallet and 0 < tokens <= 10M (base units) required" }, 400);
  if (!env.SOLANA_RPC_URL || !deployment.collateralMint) return json({ error: "mint unavailable" }, 503);
  const signing = await resolveKeeperSigning(env);
  if (signing.state !== "signer-ready" || !signing.signer) return json({ error: "keeper signer unavailable" }, 503);
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL);
  const keeper = getBase58Decoder().decode(await signing.signer.publicKey());
  const instructions = await faucetInstructions(keeper, wallet, deployment.collateralMint, false, tokens);
  const { value } = await l1.latestBlockhash("confirmed");
  const transaction = await signAndSerializeTransaction({ instructions, signer: signing.signer, recentBlockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) });
  const signature = await l1.sendTransaction(transaction, { preflightCommitment: "confirmed" });
  const outcome = await l1.confirmTransaction(signature, { targetCommitment: "confirmed", lastValidBlockHeight: value.lastValidBlockHeight, timeoutMs: 30_000, pollIntervalMs: 500 });
  return json({ signature, status: outcome.status }, outcome.status === "confirmed" || outcome.status === "finalized" ? 200 : 502);
}

/** POST /v1/faucet: Privy-authenticated, one claim per linked wallet per day. */
async function claimFaucet(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const body = await request.json().catch(() => null) as { wallet?: unknown; message?: unknown; signature?: unknown } | null;
  const wallet = typeof body?.wallet === "string" ? body.wallet : "";
  if (!wallet) return json({ error: "sign in first" }, 401);
  if (!env.SOLANA_RPC_URL || !env.DB || !deployment.collateralMint) return json({ error: "faucet unavailable" }, 503);
  // Either a Privy session for this wallet, or a fresh wallet-signed claim.
  if (typeof body?.message === "string" && typeof body?.signature === "string") {
    if (!await verifyFaucetSignature(wallet, body.message, body.signature, Math.floor(Date.now() / 1000))) return json({ error: "invalid wallet signature" }, 401);
  } else {
    if (!token) return json({ error: "sign in first" }, 401);
    if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return json({ error: "faucet unavailable" }, 503);
    const identity = await verifyPrivyToken(token, env.PRIVY_APP_ID, wallet, privyVerifier(env));
    if ("error" in identity) return json({ error: identity.error }, 401);
  }
  const previous = await env.DB.prepare("SELECT claimed_at AS claimedAt FROM faucet_claims WHERE wallet = ?").bind(wallet).first<{ claimedAt: number }>();
  if (previous && Date.now() - previous.claimedAt < CLAIM_INTERVAL_MS) return json({ error: "already claimed today" }, 429);
  const signing = await resolveKeeperSigning(env);
  if (signing.state !== "signer-ready" || !signing.signer) return json({ error: "faucet signer unavailable" }, 503);
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL);
  const keeper = getBase58Decoder().decode(await signing.signer.publicKey());
  const [balance, keeperBalance] = await Promise.all([wallet, keeper].map((key) => l1.call<{ value: number }>("getBalance", [key, { commitment: "confirmed" }])));
  // A faucet short on SOL still sends the test USDC rather than failing the whole claim.
  const sendSol = BigInt(balance.value) < SOL_TOP_UP_BELOW && BigInt(keeperBalance.value) > FAUCET_KEEPER_SOL_FLOOR;
  if (!sendSol && BigInt(balance.value) < SOL_TOP_UP_BELOW) console.warn("faucet keeper is low on SOL; sending USDC only", keeper);
  const instructions = await faucetInstructions(keeper, wallet, deployment.collateralMint, sendSol);
  const { value } = await l1.latestBlockhash("confirmed");
  const transaction = await signAndSerializeTransaction({ instructions, signer: signing.signer, recentBlockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) });
  const signature = await l1.sendTransaction(transaction, { preflightCommitment: "confirmed" });
  const outcome = await l1.confirmTransaction(signature, { targetCommitment: "confirmed", lastValidBlockHeight: value.lastValidBlockHeight, timeoutMs: 30_000, pollIntervalMs: 500 });
  if (outcome.status !== "confirmed" && outcome.status !== "finalized") return json({ error: `faucet transfer ${outcome.status}`, signature }, 502);
  await env.DB.prepare("INSERT INTO faucet_claims (wallet, claimed_at) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET claimed_at = excluded.claimed_at").bind(wallet, Date.now()).run();
  return json({ signature, tokens: FAUCET_TOKENS.toString(), sol: BigInt(balance.value) < SOL_TOP_UP_BELOW });
}

/** The market maker runs as its own service (services/market-maker) on a VM
 * next to the rollup; its status is proxied here so the terminal keeps one origin. */
async function marketMakerStatus(env: Env): Promise<Response> {
  if (!env.MM_STATUS_URL) return json({ running: false, error: "market maker backend not configured" }, 503);
  const upstream = await fetch(env.MM_STATUS_URL, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  if (!upstream?.ok) return json({ running: false, error: "market maker backend unreachable" }, 502);
  const response = new Response(upstream.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return response;
}

const PUBLIC_POST_ROUTES = new Set(["/v1/oracle/refresh", "/v1/faucet"]);
let inflightRefresh: Promise<RefreshResult> | null = null;
/** One refresh per isolate at a time; concurrent callers share its result. */
function refreshSnapshotOnce(env: Env): Promise<RefreshResult> {
  inflightRefresh ??= runOracleRefresh(env).finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}


const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const publicPost = PUBLIC_POST_ROUTES.has(new URL(request.url).pathname);
    if (request.method === "OPTIONS") return preflight(request, env, publicPost);
    return applyCors(request, env, await worker.handle(request, env), publicPost);
  },
  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /v1/markets/TSLA-PERP/candles?resolution=5&from=..&to=.. (Pyth Pro history).
    if (request.method === "GET" && parts[0] === "v1" && parts[1] === "markets" && parts[3] === "candles" && parts.length === 4) {
      if (parts[2] !== "TSLA-PERP" || !env.PYTH_PRO_API_KEY) return json({ s: "error", errmsg: "no history for this market" }, 404);
      const query = parseCandleQuery(url.searchParams);
      if (!query) return json({ s: "error", errmsg: "invalid candle query" }, 400);
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = json(await fetchCandles(env.PYTH_PRO_API_KEY, deployment.oracle.symbol, query));
      response.headers.set("cache-control", "public, max-age=30");
      await cache.put(request, response.clone());
      return response;
    }

    if (request.method === "GET" && url.pathname === "/v1/pre-ipo") {
      const response = json({ tokens: await fetchPreIpoTokens() });
      response.headers.set("cache-control", "public, max-age=60");
      return response;
    }
    if (request.method === "POST" && url.pathname === "/v1/faucet") return claimFaucet(request, env);
    if (request.method === "POST" && url.pathname === "/v1/operator/mint") return operatorMint(request, env);
    if (request.method === "GET" && url.pathname === "/v1/mm/status") return marketMakerStatus(env);

    if (request.method === "POST" && url.pathname === "/v1/oracle/refresh") {
      const result = await refreshSnapshotOnce(env);
      return json(result, result.status === "failed" ? 503 : 200);
    }

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
    // dedicated route module derives all child PDAs and fails closed when
    // any authoritative shard is missing or malformed.
    const v3Route = await handleV3MarketRoute(request, env, parts);
    if (v3Route) return v3Route;

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
      if (body.domain !== undefined && body.domain !== "l1" && body.domain !== "er") {
        return json({ error: "invalid_domain" }, 400);
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
        { transactionBase64: body.transactionBase64, expectedProgramAddress: STOCKSTREAM_PROGRAM_ID, sessionSignerAddress: body.sessionSignerAddress, expectedMarket: body.expectedMarket, ownerWallet: body.ownerWallet, recentBlockhashValid: async (blockhash) => (await transport.isBlockhashValid(blockhash, "confirmed")).value },
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
        : await verifyPrivyToken(privyToken, env.PRIVY_APP_ID!, body.ownerWallet, privyVerifier(env));
      if ("error" in privyResult) return json({ error: privyResult.error }, 401);

      // Authoritative on-chain chain: market bytes, the real TradingSession
      // PDA this relayer itself derives (never a client-supplied address),
      // and the session's own owner/signer/market/seat/expiry/revocation/
      // action-allowlist/nonce -- all checked against genuine RPC reads.
      const marketAccount = await transport.account(body.expectedMarket).catch(() => null);
      if (!marketAccount?.value?.data) return json({ error: "market_not_found" }, 404);
      const marketBytes = Uint8Array.from(atob(marketAccount.value.data[0]), (c) => c.charCodeAt(0));
      const v3Core = decodeV3Core(marketBytes);
      let v3Seat: import('./v3-market-state').V3SeatPositionState | null = null;
      if (v3Core) {
        if (marketAccount.value.owner !== STOCKSTREAM_PROGRAM_ID) return json({ error: "market_wrong_owner" }, 403);
        const seatShardAddress = await deriveSeatShardV3(body.expectedMarket, Math.floor(shapeCheck.seatIndex / 32));
        const seatShardAccount = await transport.account(seatShardAddress).catch(() => null);
        if (!seatShardAccount?.value?.data || seatShardAccount.value.owner !== STOCKSTREAM_PROGRAM_ID) return json({ error: "seat_shard_not_found" }, 404);
        const seatShard = decodeV3SeatShard(Uint8Array.from(atob(seatShardAccount.value.data[0]), (c) => c.charCodeAt(0)));
        v3Seat = seatShard?.positions.find((position) => position.slot === shapeCheck.seatIndex % 32) ?? null;
      }

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
        orderIntent: shapeCheck.orderIntent,
        now: new Date(),
        domain: body.domain === "er" ? "er" : "l1",
        v3: v3Core ? { core: v3Core, seat: v3Seat } : undefined,
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
    // The Pyth snapshot is refreshed by the market-maker service on the VM
    // (every few seconds while open) and by each order; not here, where the
    // verify-and-sign work pushed cron runs over the CPU limit.
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
      // Opt-in: these jobs submit transactions, so they never start just
      // because a cron trigger exists.
      if (env.KEEPER_ORCHESTRATION === "on") await runKeeperOrchestrationTick(env).catch(() => {});
    }
  },
} satisfies ExportedHandler<Env> & { handle(request: Request, env: Env): Promise<Response> };
export default worker;
