import { describe, expect, it } from "vitest";
import { createOracleFreshness } from "./oracle-freshness";

const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe("createOracleFreshness", () => {
  it("accepts fresh or refreshed snapshots and reports failures plainly", async () => {
    const ok = createOracleFreshness({ marketApiUrl: "https://api", readErSequence: async () => 9n, fetcher: reply({ status: "refreshed", sequence: "9" }) });
    await expect(ok.l1()).resolves.toBeUndefined();
    const down = createOracleFreshness({ marketApiUrl: "https://api", readErSequence: async () => null, fetcher: reply({ status: "failed", reason: "keeper unfunded" }, 503) });
    await expect(down.l1()).rejects.toThrow("keeper unfunded");
  });
  it("waits for MagicBlock to serve the refreshed sequence before ER submission", async () => {
    let seen = 7n;
    const f = createOracleFreshness({ marketApiUrl: "https://api", readErSequence: async () => seen++, fetcher: reply({ status: "refreshed", sequence: "9" }), sleep: async () => {} });
    await expect(f.er()).resolves.toBeUndefined();
    expect(seen).toBe(10n);
    const never = createOracleFreshness({ marketApiUrl: "https://api", readErSequence: async () => 1n, fetcher: reply({ status: "fresh", sequence: "9" }), sleep: async () => {}, erTimeoutMs: 400 });
    await expect(never.er()).rejects.toThrow("MagicBlock");
  });

  it("skips the refresh when the rollup's price is already recent, and refreshes when it is not", async () => {
    let refreshes = 0;
    const fetcher = (async () => { refreshes += 1; return new Response(JSON.stringify({ status: "fresh", sequence: "5" })); }) as typeof fetch;
    const recent = createOracleFreshness({ marketApiUrl: "https://api.test", fetcher, readErSequence: async () => 5n, readErPublishTime: async () => 1_000n, now: () => 1_003_000 });
    await recent.er();
    expect(refreshes).toBe(0);
    const old = createOracleFreshness({ marketApiUrl: "https://api.test", fetcher, readErSequence: async () => 5n, readErPublishTime: async () => 1_000n, now: () => 1_009_000 });
    await old.er();
    expect(refreshes).toBe(1);
  });
});
