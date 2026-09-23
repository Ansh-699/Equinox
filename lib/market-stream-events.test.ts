import { describe, expect, it } from "vitest";
import { marketStreamEvents } from "./market-stream-events";

describe("marketStreamEvents", () => {
  it("reads per-domain, flat and single-event payloads", () => {
    const event = { kind: "book", payload: {} };
    expect(marketStreamEvents({ type: "snapshot", domains: [{ domain: "l1", events: [event] }, { domain: "er", events: [] }] })).toEqual([event]);
    expect(marketStreamEvents({ events: [event] })).toEqual([event]);
    expect(marketStreamEvents(event)).toEqual([event]);
  });
  it("never throws on malformed payloads", () => {
    for (const bad of [null, 7, "x", {}, { events: null }, { domains: [null, { events: "x" }] }]) expect(marketStreamEvents(bad)).toEqual([]);
  });
});
