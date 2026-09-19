import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  V3_BOOK_PAGE_SIZE, V3_BOOK_SLOTS_PER_SIDE, V3_COMMIT_ACCOUNT_HARD_MAX,
  V3_COMMIT_ACCOUNT_SAFE_MAX, V3_EVENT_SHARD_SIZE, V3_MARKET_CORE_SIZE,
  V3_SEAT_SHARD_SIZE, deriveBookPageV3, deriveEventShardV3,
  deriveMarketCoreV3, deriveSeatShardV3, v3AccountIsCommittable,
} from "./v3";

describe("V3 sharded ABI", () => {
  const instrument = new PublicKey("11111111111111111111111111111111");

  it("keeps the required 1,024 slots per side below MagicBlock commit limits", () => {
    expect(V3_BOOK_SLOTS_PER_SIDE).toBe(1_024);
    for (const size of [V3_MARKET_CORE_SIZE, V3_BOOK_PAGE_SIZE, V3_SEAT_SHARD_SIZE, V3_EVENT_SHARD_SIZE]) {
      expect(v3AccountIsCommittable(size)).toBe(true);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_SAFE_MAX);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_HARD_MAX);
    }
    expect(v3AccountIsCommittable(222_752)).toBe(false);
  });

  it("derives distinct page and shard PDAs from the V3 core", () => {
    const market = deriveMarketCoreV3(instrument);
    expect(deriveBookPageV3(market, 0, 0)).not.toEqual(deriveBookPageV3(market, 0, 1));
    expect(deriveBookPageV3(market, 0, 0)).not.toEqual(deriveBookPageV3(market, 1, 0));
    expect(deriveSeatShardV3(market, 0)).not.toEqual(deriveSeatShardV3(market, 1));
    expect(deriveEventShardV3(market, 0)).not.toEqual(deriveEventShardV3(market, 1));
    expect(() => deriveBookPageV3(market, 2, 0)).toThrow(RangeError);
    expect(() => deriveSeatShardV3(market, 4)).toThrow(RangeError);
  });
});
