import { expect, test } from "vitest";
import { fetchCandles, parseCandleQuery } from "./candles";

test("accepts only known resolutions and bounded, ordered ranges", () => {
  expect(parseCandleQuery(new URLSearchParams("resolution=5&from=100&to=200"))).toEqual({ resolution: "5", from: 100, to: 200 });
  for (const bad of ["resolution=7&from=100&to=200", "resolution=5&from=200&to=100", "resolution=5&from=x&to=200", "resolution=5&from=1&to=99999999"]) {
    expect(parseCandleQuery(new URLSearchParams(bad))).toBeNull();
  }
});

test("proxies the symbol with the key server-side and labels the source", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const body = await fetchCandles("secret", "Equity.US.TSLA/USD", { resolution: "5", from: 1, to: 2 }, async (input, init) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
    return new Response(JSON.stringify({ s: "ok", t: [1] }));
  });
  expect(seen).toEqual({ url: expect.stringContaining("symbol=Equity.US.TSLA%2FUSD&resolution=5&from=1&to=2"), auth: "Bearer secret" });
  expect(body).toEqual({ s: "ok", t: [1], src: "pyth-pro" });
});
