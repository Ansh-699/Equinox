import type { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import { fetchAuthoritativeMarketState, type MarketState } from "./market-state";

/**
 * Concrete active-market discovery (Priority 8, Section 4). Combines the D1
 * market registry (identity/configuration only: symbol, addresses, oracle
 * feed, configured session policy) with the authoritative on-chain decode
 * -- the registry is never trusted for anything the chain itself defines
 * (mode, authorities, funding, open interest, oracle validity).
 *
 * A market whose account can't be fetched or decoded is skipped, not
 * fatal: it is reported in `errors` and excluded from `markets`, so one
 * broken market never aborts the rest of a scheduled invocation.
 */

export interface MarketRegistryRow {
  symbol: string;
  instrumentId: string;
  marketIndex: number;
  marketPda: string;
  vaultPda: string;
  status: "active" | "paused" | "restricted";
  oracleFeedId: string;
  sessionPolicy: "regular" | "extended" | "close-only";
}

export interface ActiveMarket {
  registry: MarketRegistryRow;
  state: MarketState;
}

export interface MarketDiscoveryError {
  symbol: string;
  marketPda: string;
  reason: string;
}

export interface MarketDiscoveryResult {
  markets: ActiveMarket[];
  errors: MarketDiscoveryError[];
}

export async function loadMarketRegistry(db: D1Database): Promise<MarketRegistryRow[]> {
  const result = await db
    .prepare(
      "SELECT symbol, instrument_id AS instrumentId, market_index AS marketIndex, market_pda AS marketPda, vault_pda AS vaultPda, status, oracle_feed_id AS oracleFeedId, session_policy AS sessionPolicy FROM markets ORDER BY market_index",
    )
    .all<MarketRegistryRow>();
  return result.results;
}

/** `maxMarkets` bounds total per-invocation work (Section 11's "maximum
 * markets per invocation" budget) -- a registry larger than the bound is
 * still fully iterated across successive scheduled invocations since the
 * registry's own `market_index` ordering is stable, not re-randomized. */
export async function discoverActiveMarkets(
  db: D1Database,
  transport: SolanaL1Transport | MagicRouterTransport,
  maxMarkets = 50,
): Promise<MarketDiscoveryResult> {
  const registry = await loadMarketRegistry(db);
  const markets: ActiveMarket[] = [];
  const errors: MarketDiscoveryError[] = [];
  for (const row of registry.slice(0, maxMarkets)) {
    if (row.status === "restricted") continue;
    let state: MarketState | null;
    try {
      state = await fetchAuthoritativeMarketState(transport, row.marketPda);
    } catch (error) {
      errors.push({ symbol: row.symbol, marketPda: row.marketPda, reason: error instanceof Error ? error.message : "unknown transport error" });
      continue;
    }
    if (!state) {
      errors.push({ symbol: row.symbol, marketPda: row.marketPda, reason: "market account missing or failed to decode" });
      continue;
    }
    markets.push({ registry: row, state });
  }
  return { markets, errors };
}
