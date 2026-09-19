import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("V3 lifecycle runner", () => {
  it("is read-only by default and declares a separate protected checkpoint", () => {
    const output = execFileSync("node", ["scripts/v3-devnet-lifecycle.mjs", "plan"], { encoding: "utf8" });
    const plan = JSON.parse(output);
    expect(plan.version).toBe(3);
    expect(plan.execute).toBe(false);
    expect(plan.statePath).toContain("v3-lifecycle-state");
    expect(plan.protectedV2Market).toBe("9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS");
  });
});
