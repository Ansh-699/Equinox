import test from "node:test";
import assert from "node:assert/strict";
import { validateCheckpoint, validateCrashResumeCoverage, validateV3CommitEpoch, validateV3CoreBytes } from "./v3-sharded-commit-guard.mjs";

const accounts = ["child-0", "child-1"].map((value) => ({ toBase58: () => value }));
const allAccounts = Array.from({ length: 26 }, (_, index) => ({ toBase58: () => `child-${index}` }));
const valid = { version: 1, mode: "commit", next: 2, events: [
  { index: 0, child: "child-0", sequence: 10 },
  { index: 1, child: "child-1", sequence: 11 },
], complete: true };

test("accepts an ordered completed checkpoint", () => {
  assert.doesNotThrow(() => validateCheckpoint(valid, "commit", accounts));
});

test("rejects reordered or mode-mismatched checkpoints", () => {
  assert.throws(() => validateCheckpoint({ ...valid, events: [{ ...valid.events[1], index: 0 }, valid.events[0] ] }, "commit", accounts), /mismatch/);
  assert.throws(() => validateCheckpoint(valid, "undelegate", accounts), /mode mismatch/);
});

test("rejects incomplete checkpoints marked complete", () => {
  assert.throws(() => validateCheckpoint({ ...valid, next: 1, events: valid.events.slice(0, 1), complete: true }, "commit", accounts), /unfinished/);
});

test("accepts and rejects the exact V3 core ABI", () => {
  const bytes = Buffer.alloc(4_096); Buffer.from("STKMK003").copy(bytes); bytes.writeUInt16LE(3, 8);
  assert.doesNotThrow(() => validateV3CoreBytes(bytes));
  assert.throws(() => validateV3CoreBytes(Buffer.alloc(4_096)), /not a V3/);
  assert.throws(() => validateV3CoreBytes(Buffer.alloc(4_095)), /not a V3/);
});

test("requires the core commit cursor to match the next shard epoch", () => {
  const bytes = Buffer.alloc(4_096); Buffer.from("STKMK003").copy(bytes); bytes.writeUInt16LE(3, 8); bytes.writeBigUInt64LE(12n, 198);
  assert.doesNotThrow(() => validateV3CommitEpoch(bytes, 12));
  assert.throws(() => validateV3CommitEpoch(bytes, 11), /epoch mismatch/);
});

test("covers crash and resume after every child for commit and undelegation", () => {
  assert.equal(validateCrashResumeCoverage(allAccounts, "commit"), true);
  assert.equal(validateCrashResumeCoverage(allAccounts, "undelegate"), true);
});
