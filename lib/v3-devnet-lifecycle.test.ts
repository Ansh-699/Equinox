import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("V3 lifecycle runner", () => {
  it("is read-only by default and declares a separate protected checkpoint", () => {
    const output = execFileSync("node", ["scripts/v3-devnet-lifecycle.mjs", "plan"], { encoding: "utf8" });
    const plan = JSON.parse(output);
    expect(plan.version).toBe(3);
    expect(plan.execute).toBe(false);
    expect(plan.statePath).toContain("v3-lifecycle-state");
    expect(plan.protectedAccounts).toEqual([
      "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso",
      "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei",
      "9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS",
    ]);
    expect(plan.oracle).toEqual({ feedId: 922, channel: 2, channelName: "fixed_rate@50ms", exponent: -5, symbol: "Equity.US.AAPL/USD" });
    expect(plan.stages.setup).not.toContain("complete on Devnet");
    expect(plan.stages.commit).toMatch(/complete|blocked\/pending/);
  });

  it("accepts an isolated entitled-equity oracle configuration without changing the default", () => {
    const output = execFileSync("node", ["scripts/v3-devnet-lifecycle.mjs", "plan"], {
      encoding: "utf8",
      env: {
        ...process.env,
        V3_ORACLE_SYMBOL: "Equity.US.TSLA/USD",
        V3_ORACLE_FEED_ID: "1435",
        V3_ORACLE_CHANNEL: "fixed_rate@50ms",
        V3_ORACLE_EXPONENT: "-5",
      },
    });
    expect(JSON.parse(output).oracle).toEqual({
      feedId: 1435,
      channel: 2,
      channelName: "fixed_rate@50ms",
      exponent: -5,
      symbol: "Equity.US.TSLA/USD",
    });
  });

  it("configures instrument metadata before activation and refuses conflicting metadata", () => {
    const source = fs.readFileSync("scripts/v3-devnet-lifecycle.mjs", "utf8");
    expect(source).toContain("createAccountWithSeed");
    expect(source).toContain("V3_INSTRUMENT_ID_HEX");
    expect(source.indexOf("simulateTransaction")).toBeGreaterThan(-1);
    expect(source.indexOf("simulateTransaction")).toBeLessThan(source.indexOf("sendAndConfirmTransaction(connection"));
    expect(source).toContain("simulation rejected");
    expect(source.indexOf("configure V3 instrument oracle")).toBeGreaterThan(-1);
    expect(source.indexOf("configure V3 instrument oracle")).toBeLessThan(source.indexOf("activate V3 core"));
    expect(source).toContain("instrument oracle metadata conflict");
    expect(source).toContain("activationBlocked: \"oracle_unavailable\"");
  });
});
