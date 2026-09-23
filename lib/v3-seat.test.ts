import { describe, expect, it } from "vitest";
import { resolveV3Seat } from "./v3-seat";

describe("resolveV3Seat", () => {
  const positions = [{ shard: 0, slot: 0, trader: "maker" }, { shard: 0, slot: 1, trader: "taker" }, { shard: 1, slot: 0, trader: "other" }];
  it("returns the wallet's own seat, never another trader's", () => {
    expect(resolveV3Seat(positions, "taker")).toEqual({ seatIndex: 1, existing: true });
    expect(resolveV3Seat(positions, "other")).toEqual({ seatIndex: 32, existing: true });
  });
  it("offers the first free seat to a new wallet and null when full", () => {
    expect(resolveV3Seat(positions, "new")).toEqual({ seatIndex: 2, existing: false });
    const full = Array.from({ length: 128 }, (_, i) => ({ shard: Math.floor(i / 32), slot: i % 32, trader: `t${i}` }));
    expect(resolveV3Seat(full, "new")).toBeNull();
  });
});
