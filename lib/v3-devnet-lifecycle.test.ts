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
    expect(plan.protectedV2Market).toBe("9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS");
    expect(plan.stages.setup).not.toContain("complete on Devnet");
    expect(plan.stages.commit).toMatch(/complete|blocked\/pending/);
  });

  it("configures instrument metadata before activation and refuses conflicting metadata", () => {
    const source = fs.readFileSync("scripts/v3-devnet-lifecycle.mjs", "utf8");
    expect(source.indexOf("configure V3 instrument oracle")).toBeGreaterThan(-1);
    expect(source.indexOf("configure V3 instrument oracle")).toBeLessThan(source.indexOf("activate V3 core"));
    expect(source).toContain("instrument oracle metadata conflict");
    expect(source).toContain("activationBlocked: \"oracle_unavailable\"");
  });
});
