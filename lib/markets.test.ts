import { describe, expect, it } from "vitest";
import { MARKET_BY_SYMBOL, PERP_MARKETS, deriveInstrumentPda, derivePerpMarketPda, deriveScratchPda, deriveVaultPda } from "./markets";

describe("generic market registry", () => {
  it("declares only the manifest's deployed TSLA market live", () => {
    expect(PERP_MARKETS.map((market) => market.symbol)).toEqual(["AAPL-PERP", "TSLA-PERP", "NVDA-PERP"]);
    expect(PERP_MARKETS.filter((market) => market.live).map((market) => market.symbol)).toEqual(["TSLA-PERP"]);
    expect(new Set(PERP_MARKETS.map((market) => market.marketPda)).size).toBe(3);
  });
  it("derives independent instrument, market, vault and scratch addresses", () => {
    const apple = MARKET_BY_SYMBOL.get("AAPL-PERP")!;
    const tesla = MARKET_BY_SYMBOL.get("TSLA-PERP")!;
    expect(apple.instrumentPda).not.toBe(tesla.instrumentPda);
    expect(apple.marketPda).not.toBe(tesla.marketPda);
    expect(apple.vaultPda).not.toBe(tesla.vaultPda);
    expect(apple.scratchPda(0)).not.toBe(tesla.scratchPda(0));
    expect(derivePerpMarketPda(deriveInstrumentPda(apple.id)).toBase58()).toBe(apple.marketPda);
    expect(deriveVaultPda(derivePerpMarketPda(deriveInstrumentPda(apple.id))).toBase58()).toBe(apple.vaultPda);
    expect(deriveScratchPda(derivePerpMarketPda(deriveInstrumentPda(apple.id)), 0).toBase58()).toBe(apple.scratchPda(0));
  });
  it("keeps feed and session policy market-scoped", () => {
    const apple = MARKET_BY_SYMBOL.get("AAPL-PERP")!;
    const tesla = MARKET_BY_SYMBOL.get("TSLA-PERP")!;
    expect(apple.marketSession).not.toBe(tesla.marketSession);
    expect(apple.oracleFeedId).not.toBe(tesla.oracleFeedId);
  });
});
