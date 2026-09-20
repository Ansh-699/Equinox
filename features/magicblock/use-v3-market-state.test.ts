import { describe, expect, it } from "vitest";
import { summarizeV3Aggregate } from "./use-v3-market-state";

describe("summarizeV3Aggregate", () => {
  it("retains shard, position, event, delegation, and commit state", () => {
    expect(summarizeV3Aggregate({
      completeExecutionState: true,
      withdrawalReady: true,
      bookPages: Array.from({ length: 18 }),
      seatShards: Array.from({ length: 4 }),
      eventShards: [{ records: [null, { kind: 200 }] }, { records: [{ kind: 201 }] }],
      positions: [{ slot: 0 }, { slot: 32 }],
      core: { delegationStatus: 3, expectedCommitSequence: "8", lastCommittedSequence: "7" },
    })).toEqual({
      completeExecutionState: true, withdrawalReady: true, bookPageCount: 18,
      seatShardCount: 4, eventShardCount: 2, positionCount: 2, eventCount: 2,
      delegationStatus: 3, expectedCommitSequence: 8n, lastCommittedSequence: 7n,
    });
  });

  it("fails closed for malformed or absent aggregate fields", () => {
    expect(summarizeV3Aggregate({ completeExecutionState: "true", withdrawalReady: 1, core: { expectedCommitSequence: "-1" } })).toEqual({
      completeExecutionState: false, withdrawalReady: false, bookPageCount: 0,
      seatShardCount: 0, eventShardCount: 0, positionCount: 0, eventCount: 0,
      delegationStatus: null, expectedCommitSequence: null, lastCommittedSequence: null,
    });
  });
});
