import { describe, expect, it } from "vitest";
import { createPythUpdateSource, pythSourceHealth, reconcileEndpointUpdates, type PythSignedUpdate } from "./pyth-source";

const update = (overrides: Partial<PythSignedUpdate> = {}): PythSignedUpdate => ({
  feedId: "Equity.US.AAPL/USD",
  timestamp: 100,
  payloadHash: "hash-a",
  message: new Uint8Array([1, 2, 3]),
  endpoint: "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  ...overrides,
});

describe("pythSourceHealth", () => {
  it("is configuration_blocked with no API key", () => {
    expect(pythSourceHealth({ endpoints: ["a", "b", "c"], feedId: "x", minChannel: "fixed_rate@200ms" })).toBe("configuration_blocked");
  });

  it("is configuration_blocked with fewer than three endpoints even with a key", () => {
    expect(pythSourceHealth({ apiKey: "k", endpoints: ["a", "b"], feedId: "x", minChannel: "fixed_rate@200ms" })).toBe("configuration_blocked");
  });

  it("is ready with a key and three endpoints", () => {
    expect(pythSourceHealth({ apiKey: "k", endpoints: ["a", "b", "c"], feedId: "x", minChannel: "fixed_rate@200ms" })).toBe("ready");
  });
});

describe("reconcileEndpointUpdates", () => {
  it("rejects everything at or before the last accepted timestamp", () => {
    const result = reconcileEndpointUpdates([update({ timestamp: 100 }), update({ timestamp: 99 })], 100);
    expect(result.accepted).toBeNull();
  });

  it("accepts the newest update when all endpoints agree", () => {
    const result = reconcileEndpointUpdates(
      [update({ timestamp: 101, endpoint: "a" }), update({ timestamp: 101, endpoint: "b" }), update({ timestamp: 101, endpoint: "c" })],
      100,
    );
    expect(result.accepted?.timestamp).toBe(101);
    expect(result.quarantined).toHaveLength(0);
  });

  it("quarantines and accepts nothing when two endpoints disagree at the same timestamp", () => {
    const result = reconcileEndpointUpdates(
      [update({ timestamp: 101, payloadHash: "hash-a", endpoint: "a" }), update({ timestamp: 101, payloadHash: "hash-b", endpoint: "b" })],
      100,
    );
    expect(result.accepted).toBeNull();
    expect(result.quarantined).toHaveLength(2);
  });

  it("ignores a stale endpoint's older report when another endpoint has a newer one", () => {
    const result = reconcileEndpointUpdates([update({ timestamp: 90, endpoint: "slow" }), update({ timestamp: 105, endpoint: "fast" })], 100);
    expect(result.accepted?.timestamp).toBe(105);
    expect(result.accepted?.endpoint).toBe("fast");
  });
});

describe("createPythUpdateSource", () => {
  it("never polls and returns null when configuration_blocked (no API key)", async () => {
    let polled = false;
    const source = createPythUpdateSource({ endpoints: ["a", "b", "c"], feedId: "x", minChannel: "fixed_rate@200ms" }, async () => {
      polled = true;
      return [update()];
    });
    expect(await source.fetchSignedUpdate(0, "")).toBeNull();
    expect(polled).toBe(false);
  });

  it("returns the accepted update when configured and endpoints agree", async () => {
    const source = createPythUpdateSource({ apiKey: "k", endpoints: ["a", "b", "c"], feedId: "x", minChannel: "fixed_rate@200ms" }, async () => [
      update({ timestamp: 200 }),
    ]);
    const result = await source.fetchSignedUpdate(100, "");
    expect(result?.timestamp).toBe(200);
    expect(result?.feedId).toBe("Equity.US.AAPL/USD");
  });

  it("returns null on conflicting payloads rather than picking one arbitrarily", async () => {
    const source = createPythUpdateSource({ apiKey: "k", endpoints: ["a", "b", "c"], feedId: "x", minChannel: "fixed_rate@200ms" }, async () => [
      update({ timestamp: 200, payloadHash: "a" }),
      update({ timestamp: 200, payloadHash: "b" }),
    ]);
    expect(await source.fetchSignedUpdate(100, "")).toBeNull();
  });
});
