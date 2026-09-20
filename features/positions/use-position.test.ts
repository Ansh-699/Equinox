import { describe, expect, it } from "vitest";
import { decodeV3Position } from "./use-position";

const base = {
  shard: 1, slot: 2, trader: "wallet", availableCollateral: "100", reservedMargin: "4",
  basePosition: "-3", quoteEntryValue: "300", realizedPnl: "-2", lastFundingAccumulator: "8",
  openBidExposure: "1", openAskExposure: "2", openOrderCount: 3, liquidationState: 0, sequence: "9",
};

describe("decodeV3Position", () => {
  it("maps a validated V3 shard projection to the position display model", () => {
    expect(decodeV3Position(base, 34)).toEqual({
      seatIndex: 34, owner: "wallet", availableCollateral: 100n, reservedMargin: 4n,
      basePosition: -3n, quoteEntryValue: 300n, realizedPnl: -2n, lastFundingAccumulator: 8n,
      openBidExposure: 1n, openAskExposure: 2n, openOrderCount: 3, liquidationState: "healthy", sequence: 9n,
    });
  });

  it("rejects a position from the wrong shard or with malformed bigint fields", () => {
    expect(decodeV3Position({ ...base, shard: 0 }, 34)).toBeNull();
    expect(decodeV3Position({ ...base, basePosition: "not-a-number" }, 34)).toBeNull();
  });
});
