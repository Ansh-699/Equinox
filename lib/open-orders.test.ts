import { describe, expect, it, vi } from "vitest";
const aggregate = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/v3-aggregate", () => ({ fetchV3Aggregate: async () => aggregate.value }));

import { classifyOpenOrdersResult, createV3OpenOrdersAdapter, unimplementedOpenOrdersAdapter, OPEN_ORDERS_UNAVAILABLE_REASON, type OpenOrderView, type OpenOrdersViewState } from "./open-orders";

const order: OpenOrderView = {
  orderKey: 1n, side: "bid", tree: "fixed", price: 100n, quantity: 5n, filledQuantity: 0n, postOnly: false, reduceOnly: false, expiresAt: null,
};

describe("unimplementedOpenOrdersAdapter", () => {
  it("always reports unavailable with the real, non-fabricated reason -- never a mock order", async () => {
    const result = await unimplementedOpenOrdersAdapter.fetchOpenOrders({ marketPda: "m", seatIndex: 0 });
    expect(result).toEqual({ status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON });
  });
});

describe("createV3OpenOrdersAdapter", () => {
  it("decodes fixed and oracle-pegged seat orders from the rollup aggregate", async () => {
    const fixedBid = ((100n << 64n) | 7n).toString();
    aggregate.value = {
      asOfSlot: 42,
      completeExecutionState: true,
      core: { lastVerifiedOraclePrice: "1000" },
      orderBook: {
        bids: [{ key: fixedBid, side: 0, owner: 0, quantity: "5", expiresAt: "18446744073709551615", priceOrOffset: "100", tree: "fixed", postOnly: true }],
        asks: [{ key: ((1100n << 64n) | 8n).toString(), side: 1, owner: 0, quantity: "2", expiresAt: "20", priceOrOffset: "25", tree: "oracle-pegged", reduceOnly: true }],
      },
    };
    const result = await createV3OpenOrdersAdapter({ marketApiUrl: "https://api.example", core: "core" }).fetchOpenOrders({ marketPda: "ignored", seatIndex: 0 });
    expect(result).toMatchObject({ status: "ready", asOfSlot: 42 });
    if (result.status !== "ready") return;
    expect(result.orders).toEqual([
      expect.objectContaining({ side: "bid", tree: "fixed", price: (2n ** 64n - 1n) - 100n, postOnly: true, expiresAt: null }),
      expect.objectContaining({ side: "ask", tree: "oracle-pegged", price: 1025n, reduceOnly: true, expiresAt: 20n }),
    ]);
  });

  it("fails closed when the rollup aggregate is unavailable", async () => {
    aggregate.value = null;
    await expect(createV3OpenOrdersAdapter({ marketApiUrl: "https://api.example", core: "core" }).fetchOpenOrders({ marketPda: "ignored", seatIndex: 0 })).resolves.toEqual({ status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON });
  });
});

describe("classifyOpenOrdersResult", () => {
  const LOADING: OpenOrdersViewState = { kind: "loading" };

  it("classifies an unavailable result", () => {
    expect(classifyOpenOrdersResult(LOADING, { status: "unavailable", reason: "blocked" })).toEqual({ kind: "unavailable", reason: "blocked" });
  });

  it("classifies a ready result with zero orders as 'empty', not 'ready' with an empty array", () => {
    expect(classifyOpenOrdersResult(LOADING, { status: "ready", orders: [], asOfSlot: 5 })).toEqual({ kind: "empty" });
  });

  it("classifies a ready result with orders as 'ready', not stale", () => {
    expect(classifyOpenOrdersResult(LOADING, { status: "ready", orders: [order], asOfSlot: 5 })).toEqual({ kind: "ready", orders: [order], stale: false });
  });

  it("a fetch failure with no prior data is a hard error", () => {
    expect(classifyOpenOrdersResult(LOADING, null, new Error("network down"))).toEqual({ kind: "error", message: "network down" });
  });

  it("a fetch failure with prior ready data falls back to stale data, not a blank error", () => {
    const previous: OpenOrdersViewState = { kind: "ready", orders: [order], stale: false };
    expect(classifyOpenOrdersResult(previous, null)).toEqual({ kind: "ready", orders: [order], stale: true });
  });

  it("a fetch failure with prior unavailable/empty/error state has no ready data to preserve -- falls to error", () => {
    expect(classifyOpenOrdersResult({ kind: "unavailable", reason: "x" }, null, new Error("boom"))).toEqual({ kind: "error", message: "boom" });
    expect(classifyOpenOrdersResult({ kind: "empty" }, null, new Error("boom"))).toEqual({ kind: "error", message: "boom" });
  });
});
