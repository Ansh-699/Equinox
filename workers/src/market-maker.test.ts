import { describe, expect, it } from "vitest";
import { ladder, LADDER_BPS } from "./mm-encoding";

describe("market-maker ladder", () => {
  it("quotes symmetric post-only rungs around the index when flat", () => {
    const quotes = ladder(38_000_000n, 0n, () => 0);
    expect(quotes).toHaveLength(LADDER_BPS.length * 2);
    const touch = (38_000_000n * LADDER_BPS[0]) / 10_000n;
    expect(quotes[0]).toEqual({ side: "bid", rung: 0, price: 38_000_000n - touch, quantity: 2n });
    expect(quotes[1]).toEqual({ side: "ask", rung: 0, price: 38_000_000n + touch, quantity: 2n });
    for (const quote of quotes) expect(quote.side === "bid" ? quote.price < 38_000_000n : quote.price > 38_000_000n).toBe(true);
  });

  it("shifts the whole ladder down when long, to shed inventory", () => {
    const flat = ladder(38_000_000n, 0n, () => 0);
    const long = ladder(38_000_000n, 100n, () => 0);
    long.forEach((quote, i) => expect(quote.price).toBeLessThan(flat[i].price));
  });
});

