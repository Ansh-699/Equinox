import deployment from "@/config/stockstream-deployment.json";
import { MagicRouterTransport } from "../workers/src/chain-transports";
import { deriveBookPageV3, deriveEventShardV3, deriveSeatShardV3, V3_BOOK_PAGES_PER_SIDE } from "../workers/src/v3-pdas";
import { fetchAuthoritativeV3Market, v3JsonValue } from "../workers/src/v3-market-state";

/** The V3 market aggregate (same JSON as the Worker's `/v1/v3/markets/:core`),
 * built in the browser from the rollup: while the market is delegated the
 * rollup is authoritative, and decoding here costs the Worker no CPU. */
export async function fetchV3Aggregate(core: string): Promise<unknown | null> {
  const [bookPages, seatShards, eventShards] = await Promise.all([
    Promise.all(Array.from({ length: 2 * V3_BOOK_PAGES_PER_SIDE }, (_, flat) => deriveBookPageV3(core, Math.floor(flat / V3_BOOK_PAGES_PER_SIDE), flat % V3_BOOK_PAGES_PER_SIDE))),
    Promise.all(Array.from({ length: 4 }, (_, shard) => deriveSeatShardV3(core, shard))),
    Promise.all(Array.from({ length: 4 }, (_, shard) => deriveEventShardV3(core, shard))),
  ]);
  const aggregate = await fetchAuthoritativeV3Market(new MagicRouterTransport(deployment.magicBlock.rpc), { core, bookPages, seatShards, eventShards });
  return aggregate ? v3JsonValue(aggregate) : null;
}
