/** V3 shard ABI. Mirrors programs/stockstream/src/v3.rs. */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

const PROGRAM_KEY = new PublicKey(PROGRAM_ID);
export const V3_LAYOUT_VERSION = 3;
export const V3_COMMIT_ACCOUNT_HARD_MAX = 65_535;
export const V3_COMMIT_ACCOUNT_SAFE_MAX = 50_000;
export const V3_MARKET_CORE_SIZE = 4_096;
export const V3_BOOK_PAGE_SIZE = 22_592;
export const V3_SEAT_SHARD_SIZE = 8_236;
export const V3_EVENT_SHARD_SIZE = 2_092;
export const V3_BOOK_NODES_PER_PAGE = 256;
export const V3_BOOK_PAGES_PER_SIDE = 4;
export const V3_BOOK_SLOTS_PER_SIDE = 1_024;
export const V3_SEATS_PER_SHARD = 32;
export const V3_SEAT_SHARDS = 4;
export const V3_EVENTS_PER_SHARD = 32;
export const V3_EVENT_SHARDS = 4;

export function deriveMarketCoreV3(instrument: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("market-v3"), instrument.toBuffer()], PROGRAM_KEY)[0];
}
export function deriveBookPageV3(market: PublicKey, side: number, page: number): PublicKey {
  if (!Number.isInteger(side) || side < 0 || side > 1 || !Number.isInteger(page) || page < 0 || page >= V3_BOOK_PAGES_PER_SIDE) throw new RangeError("invalid V3 book page");
  return PublicKey.findProgramAddressSync([Buffer.from("book-page-v3"), market.toBuffer(), Buffer.from([side]), Buffer.from([page])], PROGRAM_KEY)[0];
}
export function deriveSeatShardV3(market: PublicKey, shard: number): PublicKey {
  if (!Number.isInteger(shard) || shard < 0 || shard >= V3_SEAT_SHARDS) throw new RangeError("invalid V3 seat shard");
  return PublicKey.findProgramAddressSync([Buffer.from("seat-shard-v3"), market.toBuffer(), Buffer.from([shard])], PROGRAM_KEY)[0];
}
export function deriveEventShardV3(market: PublicKey, shard: number): PublicKey {
  if (!Number.isInteger(shard) || shard < 0 || shard >= V3_EVENT_SHARDS) throw new RangeError("invalid V3 event shard");
  return PublicKey.findProgramAddressSync([Buffer.from("event-shard-v3"), market.toBuffer(), Buffer.from([shard])], PROGRAM_KEY)[0];
}
export function v3AccountIsCommittable(size: number): boolean {
  return Number.isInteger(size) && size >= 0 && size <= V3_COMMIT_ACCOUNT_SAFE_MAX && size <= V3_COMMIT_ACCOUNT_HARD_MAX;
}
