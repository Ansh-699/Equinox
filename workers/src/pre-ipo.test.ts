import { describe, expect, it } from "vitest";
import { normalizePreStocks, normalizeTessera } from "./pre-ipo";

describe("pre-IPO normalization", () => {
  it("keeps priced rows with a mint and drops malformed ones", () => {
    expect(normalizePreStocks([{ name: "Anduril PreStocks", symbol: "ANDURIL", contract_address: "Pres1", markPrice: 151.8, tokenPrice: 149.7, markValuation: 1 }, { name: "bad" }]))
      .toEqual([{ issuer: "PreStocks", name: "Anduril PreStocks", symbol: "ANDURIL", mint: "Pres1", markPrice: 151.8, tokenPrice: 149.7, markValuation: 1, sector: null, image: null, url: null }]);
    expect(normalizeTessera([{ name: "T-OpenAI", symbol: "T-OpenAI", mint: "oPA1", markPrice: 812.79, sector: "AI" }, "junk"])).toHaveLength(1);
    expect(normalizeTessera({ not: "an array" })).toEqual([]);
  });
});
