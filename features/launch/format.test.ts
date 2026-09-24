import { describe, expect, it } from "vitest";
import { formatCompactUsd, formatTinyUsd } from "./format";

describe("formatTinyUsd", () => {
  it("collapses the leading zeros of tiny prices into a subscript count", () => {
    expect(formatTinyUsd(4.18e-7)).toBe("$0.0₆418");
    expect(formatTinyUsd(2.5e-5)).toBe("$0.0₄25");
    expect(formatTinyUsd(2e-6)).toBe("$0.0₅2");
  });

  it("prints ordinary amounts plainly", () => {
    expect(formatTinyUsd(0)).toBe("$0");
    expect(formatTinyUsd(0.0125)).toBe("$0.0125");
    expect(formatTinyUsd(99.5)).toBe("$99.50");
    expect(formatTinyUsd(250_000)).toBe("$250,000");
  });
});

describe("formatCompactUsd", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatCompactUsd(2_000)).toBe("$2K");
    expect(formatCompactUsd(1_250_000)).toBe("$1.3M");
    expect(formatCompactUsd(481)).toBe("$481.00");
  });
});
