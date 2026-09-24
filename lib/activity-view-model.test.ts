import { describe, expect, it } from "vitest";
import { toActivityRow, ACTIVITY_DETAIL_UNAVAILABLE, humanizeEventKind, matchesActivityFilter } from "./activity-view-model";

describe("toActivityRow", () => {
  it("carries the fine-grained decoded kind name through as 'detail' when present", () => {
    const row = toActivityRow({ id: "1", kind: "health", sequence: 5, domain: "l1", observedAt: 100, payload: { kind: "MarketPaused" } });
    expect(row).toEqual({ id: "1", category: "health", detail: "MarketPaused", sequence: 5, domain: "l1", observedAt: 100 });
  });

  it("is honest about missing detail -- never fabricates a fine-grained kind", () => {
    const row = toActivityRow({ id: "2", kind: "book", observedAt: 200 });
    expect(row.detail).toBe(ACTIVITY_DETAIL_UNAVAILABLE);
    expect(row.sequence).toBeNull();
    expect(row.domain).toBeNull();
  });

  it("is honest about missing detail even when payload exists but has no kind field", () => {
    const row = toActivityRow({ id: "3", kind: "fill", observedAt: 300, payload: {} });
    expect(row.detail).toBe(ACTIVITY_DETAIL_UNAVAILABLE);
  });
});

describe("humanizeEventKind", () => {
  it("splits a decoded PascalCase kind into a sentence", () => {
    expect(humanizeEventKind("OrderPartiallyFilled")).toBe("Order partially filled");
    expect(humanizeEventKind("MarketPaused")).toBe("Market paused");
  });

  it("leaves the honest placeholders untouched", () => {
    expect(humanizeEventKind(ACTIVITY_DETAIL_UNAVAILABLE)).toBe(ACTIVITY_DETAIL_UNAVAILABLE);
    expect(humanizeEventKind("Unknown(999)")).toBe("Unknown(999)");
  });
});

describe("matchesActivityFilter", () => {
  it("matches every category for 'all' and only the mapped ones otherwise", () => {
    expect(matchesActivityFilter("oracle", "all")).toBe(true);
    expect(matchesActivityFilter("fill", "trades")).toBe(true);
    expect(matchesActivityFilter("book", "trades")).toBe(false);
  });
});
