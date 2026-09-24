import { describe, expect, it } from "vitest";
import { parseLaunch } from "./launches";

describe("launch registration", () => {
  const pool = "GqayPPdhNk87efBTnTNJQPKem6mWsSBtoWjgY6KGdmFk", baseMint = "6CCai5f9yHvBNkdx1BsANk1fmxjDxZRaRjHS6Df8XyH1";
  it("accepts a well-formed launch and normalizes the symbol", () => {
    expect(parseLaunch({ pool, baseMint, symbol: "smoke", name: " Smoke Equity ", preset: "devnet" }, 5)).toEqual({ pool, baseMint, symbol: "SMOKE", name: "Smoke Equity", preset: "devnet", createdAt: 5 });
  });
  it("refuses anything that is not two addresses and a short symbol", () => {
    expect(parseLaunch({ pool: "nope", baseMint, symbol: "SMOKE", name: "x" }, 5)).toHaveProperty("error");
    expect(parseLaunch({ pool, baseMint, symbol: "WAYTOOLONGSYMBOL", name: "x" }, 5)).toHaveProperty("error");
    expect(parseLaunch(null, 5)).toHaveProperty("error");
  });
});
