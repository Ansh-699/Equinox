import { describe, expect, it } from "vitest";
import { BASKETS, sharesFor } from "./basket";
import { V3_MARKETS } from "@/lib/v3-markets";

describe("pre-IPO baskets", () => {
  it("are fully weighted and only use live pre-IPO markets", () => {
    for (const basket of BASKETS) {
      expect(basket.legs.reduce((sum, leg) => sum + leg.weight, 0)).toBeCloseTo(1);
      for (const leg of basket.legs) expect(V3_MARKETS.find((m) => m.symbol === leg.symbol)?.kind).toBe("pre-ipo");
    }
  });
  it("sizes each leg in whole shares, at least one", () => {
    expect(sharesFor(500, 115.8)).toBe(4n);
    expect(sharesFor(500, 1_366)).toBe(1n);
  });
});
