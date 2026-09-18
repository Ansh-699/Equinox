import { describe, expect, it } from "vitest";
import { classifyOpenOrdersResult, unimplementedOpenOrdersAdapter, OPEN_ORDERS_UNAVAILABLE_REASON, type OpenOrderView, type OpenOrdersViewState } from "./open-orders";

const order: OpenOrderView = {
  orderKey: 1n, side: "bid", tree: "fixed", price: 100n, quantity: 5n, filledQuantity: 0n, postOnly: false, reduceOnly: false, expiresAt: null,
};

describe("unimplementedOpenOrdersAdapter", () => {
  it("always reports unavailable with the real, non-fabricated reason -- never a mock order", async () => {
    const result = await unimplementedOpenOrdersAdapter.fetchOpenOrders({ marketPda: "m", seatIndex: 0 });
    expect(result).toEqual({ status: "unavailable", reason: OPEN_ORDERS_UNAVAILABLE_REASON });
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
