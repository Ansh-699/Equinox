import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  V3_BOOK_PAGE_SIZE, V3_BOOK_SLOTS_PER_SIDE, V3_COMMIT_ACCOUNT_HARD_MAX,
  V3_COMMIT_ACCOUNT_SAFE_MAX, V3_EVENT_SHARD_SIZE, V3_MARKET_CORE_SIZE,
  V3_SEAT_SHARD_SIZE, V3_EXECUTION_BUNDLE_LEN, deriveBookPageV3, deriveEventShardV3,
  deriveMarketCoreV3, deriveSeatShardV3, v3AccountIsCommittable,
  decodeV3BookPage, decodeV3MarketCore,
  decodeV3EventShard, decodeV3SeatShard,
} from "./v3";

describe("V3 sharded ABI", () => {
  const instrument = new PublicKey("11111111111111111111111111111111");

  it("keeps the required 1,024 slots per side below MagicBlock commit limits", () => {
    expect(V3_BOOK_SLOTS_PER_SIDE).toBe(1_024);
    expect(V3_EXECUTION_BUNDLE_LEN).toBe(27);
    for (const size of [V3_MARKET_CORE_SIZE, V3_BOOK_PAGE_SIZE, V3_SEAT_SHARD_SIZE, V3_EVENT_SHARD_SIZE]) {
      expect(v3AccountIsCommittable(size)).toBe(true);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_SAFE_MAX);
      expect(size).toBeLessThan(V3_COMMIT_ACCOUNT_HARD_MAX);
    }
    expect(v3AccountIsCommittable(222_752)).toBe(false);
    expect(v3AccountIsCommittable(10_241)).toBe(false);
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

  it("decodes V3 bytes without interpreting them as a V2 header", () => {
    const core = new Uint8Array(V3_MARKET_CORE_SIZE);
    core.set(Buffer.from("STKMK003")); new DataView(core.buffer).setUint16(8, 3, true); core[10] = 1; core[11] = 1; core[12] = 4;
    expect(decodeV3MarketCore(core)).toMatchObject({ mode: 1, oracleValid: false });
    const page = new Uint8Array(V3_BOOK_PAGE_SIZE);
    page.set(Buffer.from("STKBK003")); new DataView(page.buffer).setUint16(8, 3, true); page[10] = 1; page[11] = 3;
    expect(decodeV3BookPage(page)).toMatchObject({ side: 1, page: 3, nodeCount: 0 });
    expect(() => decodeV3MarketCore(new Uint8Array(V3_MARKET_CORE_SIZE))).toThrow(RangeError);
  });

  it("allows global metadata on page zero but bounds other pages locally", () => {
    const page = new Uint8Array(V3_BOOK_PAGE_SIZE);
    page.set(Buffer.from("STKBK003")); new DataView(page.buffer).setUint16(8, 3, true); page[10] = 0; page[11] = 0;
    new DataView(page.buffer).setUint32(60, V3_BOOK_SLOTS_PER_SIDE, true);
    expect(decodeV3BookPage(page)?.nodeCount).toBe(V3_BOOK_SLOTS_PER_SIDE);
    page[11] = 1;
    expect(() => decodeV3BookPage(page)).toThrow(RangeError);
  });

  it("decodes persisted V3 event records at shard boundaries", () => {
    const shard = new Uint8Array(3_244);
    shard.set(Buffer.from("STKEV003")); new DataView(shard.buffer).setUint16(8, 3, true); shard[10] = 0; shard[11] = 0;
    new DataView(shard.buffer).setUint16(44, 200, true); new DataView(shard.buffer).setBigUint64(48, 32n, true);
    expect(decodeV3EventShard(shard).records[0]).toMatchObject({ kind: 200, sequence: 32n });
  });

  it("decodes occupied seat positions using the generated V3 offsets", () => {
    const shard = new Uint8Array(8_236); shard.set(Buffer.from("STKST003")); new DataView(shard.buffer).setUint16(8, 3, true); shard[10] = 2; shard[11] = 0;
    const base = 44; shard[base] = 1; shard.fill(8, base + 1, base + 33);
    const view = new DataView(shard.buffer); view.setBigUint64(base + 72, 5n, true); view.setUint32(base + 168, 2, true);
    expect(decodeV3SeatShard(shard).positions[0]).toMatchObject({ shard: 2, slot: 0, basePosition: 5n, openOrderCount: 2 });
  });
});
