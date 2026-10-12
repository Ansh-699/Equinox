import { afterEach, expect, it, vi } from "vitest";
import { requestTestFunds } from "./faucet-client";

afterEach(() => vi.unstubAllGlobals());

it("explains a daily faucet limit without reporting a successful claim", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(
    { error: "already claimed today", retryAfterSeconds: 3_600 },
    { status: 429 },
  )));

  const result = await requestTestFunds({
    privyAuthenticated: true,
    getAccessToken: async () => "test-token",
    signMessage: async () => new Uint8Array(),
  }, "trading-account");

  expect(result.ok).toBe(false);
  expect(result.message).toContain("already claimed its daily test funds");
  expect(result.message).toContain("about 1 hour");
});
