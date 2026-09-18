import { describe, expect, it } from "vitest";
import { deriveOracleSafety, latestLifecycleEventKind, type OracleSafetyInput } from "./oracle-safety";

const NOW = 1_700_000_000;
function input(overrides: Partial<OracleSafetyInput> = {}): OracleSafetyInput {
  return { oracleValid: true, lastVerifiedOracleTimestamp: BigInt(NOW - 5), nowUnixSeconds: NOW, latestLifecycleEventKind: null, ...overrides };
}

describe("deriveOracleSafety", () => {
  it("is 'unknown' when the market account has never been read -- never guesses", () => {
    expect(deriveOracleSafety(input({ oracleValid: null }))).toBe("unknown");
  });

  it("a hard-override lifecycle event applies even before the account has ever been read", () => {
    expect(deriveOracleSafety(input({ oracleValid: null, latestLifecycleEventKind: "MarketPaused" }))).toBe("halted");
    expect(deriveOracleSafety(input({ oracleValid: null, latestLifecycleEventKind: "CorporateActionEntered" }))).toBe("corp_action");
  });

  it("is 'fresh' when oracleValid and within the staleness threshold", () => {
    expect(deriveOracleSafety(input())).toBe("fresh");
  });

  it("is 'stale' when oracleValid but past the staleness threshold", () => {
    expect(deriveOracleSafety(input({ lastVerifiedOracleTimestamp: BigInt(NOW - 500) }))).toBe("stale");
  });

  it("is 'stale' (not 'unknown') when the header explicitly flags oracleValid: false", () => {
    expect(deriveOracleSafety(input({ oracleValid: false }))).toBe("stale");
  });

  it("is 'unknown' when oracleValid but the timestamp itself is missing", () => {
    expect(deriveOracleSafety(input({ lastVerifiedOracleTimestamp: null }))).toBe("unknown");
  });

  it("respects a custom staleness threshold", () => {
    expect(deriveOracleSafety(input({ lastVerifiedOracleTimestamp: BigInt(NOW - 50), stalenessThresholdSeconds: 30 }))).toBe("stale");
    expect(deriveOracleSafety(input({ lastVerifiedOracleTimestamp: BigInt(NOW - 10), stalenessThresholdSeconds: 30 }))).toBe("fresh");
  });

  it("OracleStale/OracleRejected events force 'stale' even if the account still reads oracleValid: true", () => {
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "OracleStale" }))).toBe("stale");
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "OracleRejected" }))).toBe("stale");
  });

  it("MarketPaused forces 'halted' regardless of oracle freshness", () => {
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "MarketPaused" }))).toBe("halted");
  });

  it("MarketCloseOnly and MarketClosed both force 'closed'", () => {
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "MarketCloseOnly" }))).toBe("closed");
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "MarketClosed" }))).toBe("closed");
  });

  it("CorporateActionEntered forces 'corp_action'", () => {
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "CorporateActionEntered" }))).toBe("corp_action");
  });

  it("OracleUpdated/OracleRecovered/MarketResumed/CorporateActionResolved are NOT hard overrides -- they fall through to the normal freshness check", () => {
    for (const kind of ["OracleUpdated", "OracleRecovered", "MarketResumed", "CorporateActionResolved"]) {
      expect(deriveOracleSafety(input({ latestLifecycleEventKind: kind }))).toBe("fresh");
      expect(deriveOracleSafety(input({ latestLifecycleEventKind: kind, lastVerifiedOracleTimestamp: BigInt(NOW - 500) }))).toBe("stale");
    }
  });

  it("an unrecognized/irrelevant event kind is ignored, not treated as an override", () => {
    expect(deriveOracleSafety(input({ latestLifecycleEventKind: "OrderPlaced" }))).toBe("fresh");
  });
});

describe("latestLifecycleEventKind", () => {
  it("returns null when there are no lifecycle-relevant events", () => {
    expect(latestLifecycleEventKind([{ sequence: 1, payload: { kind: "OrderPlaced" } }])).toBeNull();
  });

  it("picks the highest-sequence lifecycle event, not just the last array entry", () => {
    const kind = latestLifecycleEventKind([
      { sequence: 5, payload: { kind: "MarketPaused" } },
      { sequence: 9, payload: { kind: "MarketResumed" } },
      { sequence: 3, payload: { kind: "CorporateActionEntered" } },
    ]);
    expect(kind).toBe("MarketResumed");
  });

  it("ignores an event missing a sequence number rather than guessing its order", () => {
    const kind = latestLifecycleEventKind([
      { sequence: 1, payload: { kind: "MarketPaused" } },
      { payload: { kind: "MarketResumed" } }, // no sequence -- must not win by array position
    ]);
    expect(kind).toBe("MarketPaused");
  });

  it("ignores events with no payload.kind at all", () => {
    expect(latestLifecycleEventKind([{ sequence: 1 }])).toBeNull();
  });
});
