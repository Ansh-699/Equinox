import { describe, expect, it } from "vitest";
import { nextNewKeys, type NewKeysState } from "./use-new-keys";

describe("nextNewKeys", () => {
  it("never marks the first list, marks later arrivals, forgets departed keys", () => {
    let state: NewKeysState = { seen: null, fresh: new Set() };
    state = nextNewKeys(state, ["a", "b"]);
    expect([...state.fresh]).toEqual([]);
    state = nextNewKeys(state, ["c", "a", "b"]);
    expect([...state.fresh]).toEqual(["c"]);
    state = nextNewKeys(state, ["d", "c", "a"]);
    expect([...state.fresh].sort()).toEqual(["c", "d"]);
    state = nextNewKeys(state, ["d"]);
    expect([...state.fresh]).toEqual(["d"]);
    expect(nextNewKeys(state, ["d"])).toBe(state); // nothing changed: same object, no re-render
  });
});
