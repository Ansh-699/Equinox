import { describe, expect, it } from "vitest";
import { applyEvent, nextCursor, reconcileBatch } from "./indexer";
import { retryDelay } from "./keepers";
import type { MarketSnapshot } from "./types";

const snapshot: MarketSnapshot = { symbol: "AAPL-PERP", sequence: 0, domain: "er", market: { symbol: "AAPL-PERP", instrumentId: "a", marketIndex: 0, marketPda: "m", vaultPda: "v", status: "active", oracleFeedId: "feed", sessionPolicy: "regular" }, events: [], capturedAt: 0 };

describe("market indexer", () => {
  it("accepts ordered events and rejects gaps", () => {
    const first = { id: "1", symbol: "AAPL-PERP", kind: "fill" as const, sequence: 1, domain: "er" as const, payload: {}, observedAt: 1 };
    expect(nextCursor({ market: "m", domain: "er", sequence: 0, slot: 0 }, first)?.sequence).toBe(1);
    expect(reconcileBatch(snapshot, [first]).kind).toBe("applied");
    expect(reconcileBatch(snapshot, [{ ...first, sequence: 3 }]).kind).toBe("gap");
  });
  it("deduplicates event ids in a snapshot", () => {
    const event = { id: "1", symbol: "AAPL-PERP", kind: "fill" as const, sequence: 1, payload: {}, observedAt: 1 };
    expect(applyEvent(applyEvent(snapshot, event), { ...event, payload: { changed: true } }).events).toHaveLength(1);
  });
});

describe("keeper primitives", () => {
  it("uses bounded exponential retry", () => {
    expect(retryDelay(1)).toBe(250);
    expect(retryDelay(20)).toBe(30_000);
  });
});
