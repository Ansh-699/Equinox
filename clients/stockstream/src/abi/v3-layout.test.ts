import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import layout from "./layout.json";
import { decodeV3MarketCore } from "./v3";

describe("Rust-produced delegated revision-2 core", () => {
  const bytes = Buffer.from(readFileSync(new URL("./v3-core-revision2.hex", import.meta.url), "utf8"), "hex");
  it("decodes the exact Rust serialization after validator overlay", () => {
    expect(bytes.length).toBe(layout.V3_MARKET_CORE_SIZE);
    const core = decodeV3MarketCore(bytes);
    expect(core.validator.toBase58()).toBe("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
    expect(core).toMatchObject({ initialMarginBps: 2000, maintenanceMarginBps: 1000,
      liquidationFeeBps: 50, makerFeeBps: 0, takerFeeBps: 5, maximumLeverage: 5,
      maximumPosition: 0n, maximumOpenInterest: 0n, oracleFeedId: 1435,
      oracleChannel: 2, oracleExponent: -5, lastVerifiedOraclePrice: 36982565n });
    expect(layout.V3_CORE_VALIDATOR_OFFSET).toBe(214);
    expect(layout.V3_CORE_INITIAL_MARGIN_BPS_OFFSET).toBe(1672);
    expect(layout.V3_CORE_MAXIMUM_LEVERAGE_OFFSET).toBe(1682);
  });
  it("rejects legacy and unconfigured layouts without reinterpreting risk", () => {
    for (const revision of [0, 1, 3]) {
      const old = Buffer.from(bytes); old[371] = revision;
      expect(() => decodeV3MarketCore(old)).toThrow("revision 2 required");
    }
  });
});
