import { describe, expect, it } from "vitest";
import { computeCappedFundingDelta, fundingTickDecision, type FundingPolicy } from "./funding-source";
import type { MarketState } from "./market-state";

const policy: FundingPolicy = { intervalMs: 3_600_000, capBps: 50, scale: 1_000_000n };

const market = (overrides: Partial<MarketState> = {}): MarketState => ({
  mode: 1,
  marketAuthority: "A",
  emergencyAuthority: "E",
  maintenanceMarginBps: 1000,
  makerFeeBps: 0,
  takerFeeBps: 5,
  maximumLeverage: 10,
  currentOpenInterest: 0n,
  globalOrderSequence: 0n,
  globalEventSequence: 0n,
  fundingAccumulator: 1_000n,
  lastFundingTimestamp: 1000n, // seconds
  oracleValid: true,
  lastVerifiedOraclePrice: 100_000n,
  lastVerifiedOracleTimestamp: 1000n,
  ...overrides,
});

describe("computeCappedFundingDelta", () => {
  it("is zero at zero premium", () => {
    expect(computeCappedFundingDelta(100_000n, 100_000n, policy)).toBe(0n);
  });

  it("is positive when mark trades above index, capped by policy", () => {
    // +2% premium (200 bps) clamps to the 50 bps cap.
    expect(computeCappedFundingDelta(100_000n, 102_000n, policy)).toBe((50n * 1_000_000n) / 10_000n);
  });

  it("is negative when mark trades below index, capped by policy", () => {
    expect(computeCappedFundingDelta(100_000n, 98_000n, policy)).toBe((-50n * 1_000_000n) / 10_000n);
  });

  it("is uncapped below the threshold", () => {
    // +0.1% premium = 10 bps, under the 50 bps cap.
    expect(computeCappedFundingDelta(100_000n, 100_100n, policy)).toBe((10n * 1_000_000n) / 10_000n);
  });

  it("is zero for a non-positive index price (guards divide-by-zero)", () => {
    expect(computeCappedFundingDelta(0n, 100n, policy)).toBe(0n);
  });
});

describe("fundingTickDecision", () => {
  const now = 1000 * 1000 + 3_600_000 + 1;

  it("is not eligible when the interval has not elapsed", () => {
    const decision = fundingTickDecision(market(), "open", policy, 1000 * 1000 + 1000);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/interval/);
  });

  it("is eligible once the interval has elapsed with a fresh oracle", () => {
    const decision = fundingTickDecision(market(), "open", policy, now);
    expect(decision.eligible).toBe(true);
    expect(decision.input?.computeNextAccumulator()).toBe(1_000n); // mark==index baseline -> zero delta
  });

  it("uses a supplied validated V3 mark while retaining the index fallback", () => {
    const premium = fundingTickDecision(market(), "open", policy, now, 102_000n);
    expect(premium.input?.computeNextAccumulator()).toBe(1_000n + (50n * 1_000_000n) / 10_000n);
    const discount = fundingTickDecision(market(), "open", policy, now, 98_000n);
    expect(discount.input?.computeNextAccumulator()).toBe(1_000n - (50n * 1_000_000n) / 10_000n);
  });

  it("refuses to settle funding on a stale/invalid oracle", () => {
    const decision = fundingTickDecision(market({ oracleValid: false }), "open", policy, now);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/oracle/);
  });

  it("refuses to settle funding on a halted/paused market", () => {
    const decision = fundingTickDecision(market(), "paused", policy, now);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toMatch(/mode/);
  });

  it("is still eligible in close-only mode (funding continues to accrue on open positions)", () => {
    const decision = fundingTickDecision(market(), "close-only", policy, now);
    expect(decision.eligible).toBe(true);
  });
});
