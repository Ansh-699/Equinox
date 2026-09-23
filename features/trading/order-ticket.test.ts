import { describe, expect, it } from "vitest";
import { DEFAULT_TICKET, sizeTicket } from "./order-ticket";

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
