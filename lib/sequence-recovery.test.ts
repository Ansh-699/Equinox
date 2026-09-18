import { describe, expect, it } from "vitest";
import { advanceSequence, seedFromSnapshot, INITIAL_SEQUENCE_TRACKER, type SequenceTrackerState } from "./sequence-recovery";

describe("advanceSequence", () => {
  it("classifies the first event observed for a domain as 'first', not a gap", () => {
    const result = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "er", sequence: 5, slot: 100 });
    expect(result.outcome).toBe("first");
    expect(result.state.er).toEqual({ sequence: 5, slot: 100 });
    expect(result.state.l1).toBeNull(); // the other domain's cursor is untouched
  });

  it("in-order events (sequence + 1) advance cleanly", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "l1", sequence: 1, slot: 10 });
    const second = advanceSequence(first.state, { domain: "l1", sequence: 2, slot: 11 });
    expect(second.outcome).toBe("in_order");
    expect(second.state.l1).toEqual({ sequence: 2, slot: 11 });
  });

  it("detects a gap and reports exactly how many sequence numbers were missed", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "er", sequence: 10, slot: 1 });
    const gapped = advanceSequence(first.state, { domain: "er", sequence: 14, slot: 5 });
    expect(gapped.outcome).toBe("gap");
    expect(gapped.missed).toBe(3); // 11, 12, 13 never arrived
    expect(gapped.state.er).toEqual({ sequence: 14, slot: 5 }); // still adopts the new position -- no fabricated backfill
  });

  it("treats an exact replay as a duplicate, not a gap or an error", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "l1", sequence: 7, slot: 3 });
    const replay = advanceSequence(first.state, { domain: "l1", sequence: 7, slot: 3 });
    expect(replay.outcome).toBe("duplicate");
    expect(replay.state).toBe(first.state); // unchanged reference -- no spurious update
  });

  it("treats a late/out-of-order re-delivery (lower than current) as a duplicate", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "l1", sequence: 9, slot: 3 });
    const late = advanceSequence(first.state, { domain: "l1", sequence: 4, slot: 1 });
    expect(late.outcome).toBe("duplicate");
    expect(late.state.l1).toEqual({ sequence: 9, slot: 3 }); // cursor does not regress
  });

  it("flags a slot regression on a higher sequence as an integrity anomaly, not a valid reorder", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "er", sequence: 1, slot: 100 });
    const bad = advanceSequence(first.state, { domain: "er", sequence: 2, slot: 50 });
    expect(bad.outcome).toBe("slot_regression");
  });

  it("tracks l1 and er domains completely independently -- a gap in one never affects the other", () => {
    let state: SequenceTrackerState = INITIAL_SEQUENCE_TRACKER;
    state = advanceSequence(state, { domain: "l1", sequence: 1, slot: 1 }).state;
    state = advanceSequence(state, { domain: "er", sequence: 1, slot: 1 }).state;
    const l1Gap = advanceSequence(state, { domain: "l1", sequence: 5, slot: 5 });
    expect(l1Gap.outcome).toBe("gap");
    expect(l1Gap.state.er).toEqual({ sequence: 1, slot: 1 }); // untouched by the l1 gap
    const erInOrder = advanceSequence(l1Gap.state, { domain: "er", sequence: 2, slot: 2 });
    expect(erInOrder.outcome).toBe("in_order"); // er's own sequence is unaffected by l1's gap
  });

  it("an event with no slot inherits the prior cursor's slot rather than regressing to 0", () => {
    const first = advanceSequence(INITIAL_SEQUENCE_TRACKER, { domain: "l1", sequence: 1, slot: 50 });
    const next = advanceSequence(first.state, { domain: "l1", sequence: 2 });
    expect(next.outcome).toBe("in_order");
    expect(next.state.l1).toEqual({ sequence: 2, slot: 50 });
  });
});

describe("seedFromSnapshot", () => {
  it("seeds each domain from the highest sequence observed in the snapshot, not just the last array entry", () => {
    const seeded = seedFromSnapshot(INITIAL_SEQUENCE_TRACKER, [
      { domain: "l1", sequence: 3, slot: 30 },
      { domain: "er", sequence: 9, slot: 90 },
      { domain: "l1", sequence: 7, slot: 70 }, // out of array order, but the higher sequence -- must win
    ]);
    expect(seeded.l1).toEqual({ sequence: 7, slot: 70 });
    expect(seeded.er).toEqual({ sequence: 9, slot: 90 });
  });

  it("never regresses a cursor that is already ahead of the snapshot", () => {
    const ahead: SequenceTrackerState = { l1: { sequence: 100, slot: 5 }, er: null };
    const seeded = seedFromSnapshot(ahead, [{ domain: "l1", sequence: 4, slot: 1 }]);
    expect(seeded.l1).toEqual({ sequence: 100, slot: 5 });
  });

  it("leaves a domain untouched when the snapshot has no events for it", () => {
    const seeded = seedFromSnapshot(INITIAL_SEQUENCE_TRACKER, [{ domain: "l1", sequence: 1, slot: 1 }]);
    expect(seeded.er).toBeNull();
  });
});
