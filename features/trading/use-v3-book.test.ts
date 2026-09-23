import { describe, expect, it } from "vitest";
import { levelsFrom, tradesFrom } from "./use-v3-book";

describe("levelsFrom", () => {
  it("aggregates resting leaves by price, best first, and drops expired or branch nodes", () => {
    const nodes = [
      { tag: 2, quantity: "3", priceOrOffset: "25000000", expiresAt: "9999999999" },
      { tag: 2, quantity: "2", priceOrOffset: "25000000", expiresAt: "9999999999" },
      { tag: 2, quantity: "1", priceOrOffset: "25100000", expiresAt: "9999999999" },
      { tag: 2, quantity: "9", priceOrOffset: "26000000", expiresAt: "1" },
      { tag: 1, quantity: "9", priceOrOffset: "26000000" },
    ];
    expect(levelsFrom(nodes, true, 0n, 100n)).toEqual([{ price: 251, size: 1 }, { price: 250, size: 5 }]);
    expect(levelsFrom(nodes, false, 0n, 100n)).toEqual([{ price: 250, size: 5 }, { price: 251, size: 1 }]);
  });

  it("prices oracle-pegged bids at index + offset and skips those past their limit", () => {
    const pegged = [
      { tag: 2, quantity: "4", priceOrOffset: "-100000", tree: "oracle-pegged", pegLimit: "25000000" },
      { tag: 2, quantity: "4", priceOrOffset: "100000", tree: "oracle-pegged", pegLimit: "25000000" },
    ];
    expect(levelsFrom(pegged, true, 25_000_000n, 0n)).toEqual([{ price: 249, size: 4 }]);
  });
});

describe("tradesFrom", () => {
  it("decodes fill payloads and ignores other event kinds", () => {
    const payload = new Uint8Array(48);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, true); view.setUint32(4, 2, true);
    view.setBigInt64(8, 25_050_000n, true); view.setBigUint64(16, 7n, true);
    const shards = [{ records: [{ kind: 204, sequence: "5", timestamp: "10", payload: [...payload] }, { kind: 202, sequence: "4", payload: [...payload] }, null] }];
    expect(tradesFrom(shards)).toEqual([{ sequence: "5", makerSeat: 1, takerSeat: 2, price: 250.5, size: 7, time: 10 }]);
  });
});
