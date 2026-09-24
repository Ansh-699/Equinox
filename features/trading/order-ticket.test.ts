import { describe, expect, it } from "vitest";
import { DEFAULT_TICKET, orderGuard, sizeTicket } from "./order-ticket";

describe("sizeTicket", () => {
  it("sizes a limit order as ⌊amount × multiplier ÷ price⌋ shares", () => {
    const sized = sizeTicket({ ...DEFAULT_TICKET, price: "250", amount: "1000", leverage: 3 }, 999, 2_000);
    expect(sized).toMatchObject({ shares: 12, notional: 3000, margin: 600, limitPriceUsd: "250" });
  });

  it("crosses a market order at the mark widened by slippage, against the side", () => {
    expect(sizeTicket({ ...DEFAULT_TICKET, kind: "market", side: "long", amount: "100", slippageBps: "100" }, 200, 2_000)?.limitPriceUsd).toBe("202.00");
    expect(sizeTicket({ ...DEFAULT_TICKET, kind: "market", side: "short", amount: "100", slippageBps: "100" }, 200, 2_000)?.limitPriceUsd).toBe("198.00");
  });

  it("returns null without a price or amount", () => {
    expect(sizeTicket({ ...DEFAULT_TICKET, kind: "market", amount: "100" }, null, 2_000)).toBeNull();
    expect(sizeTicket({ ...DEFAULT_TICKET, price: "250" }, 250, 2_000)).toBeNull();
  });
});

describe("orderGuard", () => {
  const base = { kind: "limit" as const, side: "long" as const, reduceOnly: false, price: "100", marginUsd: 40, markPrice: 100, availableUsd: 1_000, position: 0n as bigint | null };
  it("blocks reduce-only without a position to reduce", () => {
    expect(orderGuard({ ...base, reduceOnly: true }).block).toMatch(/needs an open position/);
    expect(orderGuard({ ...base, reduceOnly: true, position: 3n }).block).toMatch(/needs a short position/);
    expect(orderGuard({ ...base, reduceOnly: true, position: -3n }).block).toBeNull();
  });
  it("blocks orders the margin can't cover", () => {
    expect(orderGuard({ ...base, availableUsd: 10 }).block).toMatch(/deposit more/);
  });
  it("blocks fat-finger limits and warns on aggressive ones", () => {
    expect(orderGuard({ ...base, price: "115" }).block).toMatch(/15% above/);
    expect(orderGuard({ ...base, price: "105" }).warn).toMatch(/5\.0% above/);
    expect(orderGuard({ ...base, price: "80" })).toEqual({ block: null, warn: null }); // a resting bid below the market
    expect(orderGuard({ ...base, side: "short", price: "85" }).block).toMatch(/15% below/);
  });
});
