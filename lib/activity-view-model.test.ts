import { describe, expect, it } from "vitest";
import { toActivityRow, ACTIVITY_DETAIL_UNAVAILABLE } from "./activity-view-model";

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
