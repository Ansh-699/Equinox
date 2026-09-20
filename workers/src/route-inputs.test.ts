import { describe, expect, it } from "vitest";
import { asMarketDefinition, asMarketEvent } from "./route-inputs";

describe("route input validation", () => {
  it("normalizes valid market events and rejects unsequenced or unknown kinds", () => {
    expect(asMarketEvent({
      id: "event-1", symbol: "aapl-perp", kind: "fill", payload: { quantity: "1" },
      sequence: 4, domain: "er", slot: 9, observedAt: 100,
    })).toMatchObject({ id: "event-1", symbol: "AAPL-PERP", sequence: 4, domain: "er" });
    expect(asMarketEvent({ id: "event-2", symbol: "AAPL-PERP", kind: "fill", payload: {}, sequence: 0, domain: "l1" })).toBeNull();
    expect(asMarketEvent({ id: "event-3", symbol: "AAPL-PERP", kind: "unknown", payload: {}, sequence: 1, domain: "l1" })).toBeNull();
  });

  it("normalizes valid market definitions and rejects invalid lifecycle enums", () => {
    expect(asMarketDefinition({
      symbol: "aapl-perp", marketIndex: 1, instrumentId: "instrument", marketPda: "market",
      vaultPda: "vault", status: "active", oracleFeedId: "922", sessionPolicy: "regular",
    })).toMatchObject({ symbol: "AAPL-PERP", marketIndex: 1, status: "active" });
    expect(asMarketDefinition({
      symbol: "AAPL-PERP", marketIndex: 1, instrumentId: "instrument", marketPda: "market",
      vaultPda: "vault", status: "closed", oracleFeedId: "922", sessionPolicy: "regular",
    })).toBeNull();
  });
});
