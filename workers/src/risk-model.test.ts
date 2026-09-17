import { describe, expect, it } from "vitest";
import { equity, feeBps, isLiquidatable, notional, partialLiquidationQuantity, unrealizedPnl } from "./risk-model";

const seat = (overrides: Partial<Parameters<typeof equity>[0]> = {}) => ({
  availableCollateral: 1_000n,
  reservedMargin: 0n,
  basePosition: 10n,
  quoteEntryValue: 1_000n,
  realizedPnl: 0n,
  ...overrides,
});

describe("risk-model (parity with programs/stockstream/src/risk.rs)", () => {
  it("notional rejects non-positive price or negative quantity", () => {
    expect(() => notional(1n, 0n)).toThrow();
    expect(() => notional(-1n, 1n)).toThrow();
    expect(notional(10n, 5n)).toBe(50n);
  });

  it("feeBps truncates toward zero like Rust's checked_div", () => {
    expect(feeBps(999n, 50)).toBe(4n); // 999*50/10000 = 4.995 -> 4
    expect(feeBps(1_000_000n, 100)).toBe(10_000n);
  });

  it("unrealizedPnl is zero-entry when the position is flat", () => {
    expect(unrealizedPnl(seat({ basePosition: 0n, quoteEntryValue: 500n }), 100n)).toBe(0n);
  });

  it("unrealizedPnl matches current notional minus recorded entry value", () => {
    // 10 units at mark 120 = 1200 notional, minus a 1000 entry value = 200 gain.
    expect(unrealizedPnl(seat({ basePosition: 10n, quoteEntryValue: 1_000n }), 120n)).toBe(200n);
  });

  it("equity sums collateral, realized pnl and unrealized pnl", () => {
    const s = seat({ availableCollateral: 1_000n, realizedPnl: 50n, basePosition: 10n, quoteEntryValue: 1_000n });
    expect(equity(s, 120n)).toBe(1_000n + 50n + 200n);
  });

  it("is not liquidatable when equity covers the maintenance requirement", () => {
    // 10 units at mark 100: notional 1000, 10% maintenance -> requirement 100.
    // equity = 1000 collateral + 0 + (1000 - 1000) = 1000 >= 100.
    expect(isLiquidatable(seat({ availableCollateral: 1_000n }), 100n, 1_000)).toBe(false);
  });

  it("is liquidatable once equity drops below the maintenance requirement", () => {
    // Same position, mark collapses to 10: notional 100, requirement 10% -> 10.
    // equity = 1000 collateral + (10*10 - 1000) = 1000 - 900 = 100 >= 10 -> still healthy.
    // Drop collateral instead to force a real breach: equity = 5 + (10*10-1000) = 5-900 = -895 < 10.
    expect(isLiquidatable(seat({ availableCollateral: 5n }), 10n, 1_000)).toBe(true);
  });

  it("partialLiquidationQuantity halves the position with a floor of 1", () => {
    expect(partialLiquidationQuantity(seat({ basePosition: 10n }))).toBe(5n);
    expect(partialLiquidationQuantity(seat({ basePosition: -10n }))).toBe(5n);
    expect(partialLiquidationQuantity(seat({ basePosition: 1n }))).toBe(1n);
    expect(partialLiquidationQuantity(seat({ basePosition: 0n }))).toBe(1n);
  });
});
