import { address } from '@solana/kit';
import { SolanaL1Transport, MagicBlockErTransport } from './chain-transports';
import { deriveBookPageV3, deriveEventShardV3, deriveSeatShardV3, V3_BOOK_PAGES_PER_SIDE } from './v3-pdas';
import { fetchAuthoritativeV3Market, type V3MarketAggregate } from './v3-market-state';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
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
  if (!env.SOLANA_RPC_URL) { console.error('v3 aggregate unavailable: SOLANA_RPC_URL is not configured'); return null; }
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
  return fetchAuthoritativeV3Market(transport, { core: coreAddress, bookPages, seatShards, eventShards }).catch((error: unknown) => {
    console.error('v3 aggregate fetch failed', domain, error instanceof Error ? error.message : String(error));
    return null;
  });
}

/** Handles only the explicit V3 aggregate route. Returning null leaves the
 * surrounding Worker router free to handle every non-V3 path. */
export async function handleV3MarketRoute(
  request: Request,
  env: Env,
  parts: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  if (request.method !== 'GET' || parts[0] !== 'v1' || parts[1] !== 'v3' || parts[2] !== 'markets' || parts.length !== 4) return null;
  const domain = new URL(request.url).searchParams.get('domain') === 'er' ? 'er' : 'l1';
  const aggregate = await fetchV3MarketSnapshot(env, parts[3], domain, fetcher);
  return aggregate ? json(v3JsonValue(aggregate)) : json({ error: 'v3_market_unavailable', domain }, 404);
}
