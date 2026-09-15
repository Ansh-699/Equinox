import { describe, expect, it } from "vitest";
import { loadPythKeeperConfig, PythKeeper, pythHealth } from "./pyth-keeper";

const env = { PYTH_PRO_API_KEY: "server-only", PYTH_PRO_AAPL_FEED_ID: "catalog-feed", PYTH_PRO_ENDPOINTS: "https://one,https://two", STOCKSTREAM_MARKET_ADDRESS: "11111111111111111111111111111111", PYTH_PROGRAM_ADDRESS: "11111111111111111111111111111111", PYTH_STORAGE_ADDRESS: "11111111111111111111111111111111", PYTH_TREASURY_ADDRESS: "11111111111111111111111111111111", PYTH_PAYLOAD_ADDRESS: "11111111111111111111111111111111" };

describe("server-side Pyth keeper", () => {
  it("requires explicit server credentials and verified feed configuration", () => {
    expect(() => loadPythKeeperConfig({})).toThrow("PYTH_PRO_API_KEY");
    expect(pythHealth({})).toEqual({ configured: false, liveVerification: false, feedIdConfigured: false });
  });
  it("rotates endpoints and assembles verification before consume instruction", async () => {
    let calls = 0;
    const fetcher = async (endpoint: string) => { calls += 1; if (endpoint === "https://one") return new Response("failed", { status: 503 }); return Response.json({ feedId: "catalog-feed", channel: "fixed_rate@200ms", price: 100n.toString(), exponent: -2, confidence: 1n.toString(), timestamp: 1000, session: "Regular", status: "Open", payload: "010203", signature: "00".repeat(64), publicKey: "11".repeat(32) }); };
    const keeper = new PythKeeper(loadPythKeeperConfig(env), fetcher, () => 1000);
    const update = await keeper.fetchSignedUpdate();
    expect(calls).toBe(2); expect(keeper.buildTransaction(update)).toHaveLength(2); expect(keeper.health.lastTimestamp).toBe(1000);
  });
});
