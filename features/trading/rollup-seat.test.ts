import { describe, expect, it } from "vitest";
import { firstFreeSeat, seatFromPositions } from "./rollup-seat";

const position = (shard: number, slot: number, trader: string) => ({ shard, slot, trader, availableCollateral: "5000000", reservedMargin: "0", basePosition: "-3", quoteEntryValue: "0", realizedPnl: "0", openOrderCount: 2, liquidationState: 0 });

describe("rollup seat resolution", () => {
  it("finds the wallet's own seat and converts it", () => {
    const seat = seatFromPositions([position(0, 3, "maker"), position(1, 2, "me")], "me");
    expect(seat?.index).toBe(34);
    expect(seat?.view).toMatchObject({ availableCollateral: 5_000_000n, basePosition: -3n, openOrderCount: 2, liquidationState: "healthy" });
    expect(seatFromPositions([position(0, 3, "maker")], "me")).toBeNull();
  });
  it("picks the first unoccupied index", () => {
    expect(firstFreeSeat([position(0, 0, "a"), position(0, 1, "b"), position(0, 3, "c")])).toBe(2);
  });
});
