import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertV3L1Readiness, V3_LIFECYCLE_ORDER } from "./v3-lifecycle-readiness.mjs";
function fixture() {
  const core = Buffer.from(readFileSync(new URL("../clients/stockstream/src/abi/v3-core-revision2.hex", import.meta.url), "utf8"), "hex");
  const seatShards = Array.from({length:4}, () => Buffer.alloc(8236));
  seatShards[0][44] = 1; seatShards[0].writeBigUInt64LE(100n,84);
  return { core, seatShards, accountCount:27, nowSeconds:1700000000 };
}
test("custody precedes delegation and valid L1 state passes", () => {
  assert.ok(V3_LIFECYCLE_ORDER.indexOf("l1-session-allocation") < V3_LIFECYCLE_ORDER.indexOf("l1-test-collateral"));
  assert.ok(V3_LIFECYCLE_ORDER.indexOf("l1-test-collateral") < V3_LIFECYCLE_ORDER.indexOf("er-delegation"));
  assert.ok(V3_LIFECYCLE_ORDER.indexOf("session-member-delegation") < V3_LIFECYCLE_ORDER.indexOf("limited-session"));
  assert.ok(V3_LIFECYCLE_ORDER.indexOf("limited-session") < V3_LIFECYCLE_ORDER.indexOf("er-orders-and-fills"));
  assert.equal(assertV3L1Readiness(fixture()).funded,1);
});
for (const [label, mutate] of [
  ["delegated", x => { x.core[197]=1; }],
  ["stale", x => { x.nowSeconds+=11; }],
  ["future", x => { x.nowSeconds-=3; }],
  ["missing collateral", x => { x.seatShards[0].writeBigUInt64LE(0n,84); }],
  ["missing seat", x => { x.seatShards[0][44]=0; }],
  ["incomplete", x => { x.accountCount=26; }],
  ["legacy layout", x => { x.core[371]=1; }],
  ["missing feed", x => { x.core.writeUInt32LE(0,246); }],
  ["wrong exponent", x => { x.core.writeInt32LE(-6,251); }],
  ["closed", x => { x.core[1686]=3; }],
  ["halted", x => { x.core[11]=0; }],
  ["restricted", x => { x.core[11]=2; }],
]) test(`rejects ${label}`, () => { const x=fixture();mutate(x);assert.throws(()=>assertV3L1Readiness(x)); });

function snapshotFixture() {
  const x = fixture(); x.core[180] = 0; // stale core cache: the snapshot is the only price source
  const snapshot = Buffer.alloc(128); snapshot.write("STKORS03"); snapshot[87] = 1;
  snapshot.writeUInt32LE(1435, 44); snapshot[48] = 2; snapshot.writeInt32LE(-5, 49);
  snapshot.writeBigInt64LE(37_900_000n, 53); snapshot.writeBigUInt64LE(3_000n, 61);
  snapshot.writeBigUInt64LE(BigInt(x.nowSeconds - 1), 69); snapshot.writeBigUInt64LE(1n, 77);
  return { ...x, snapshot };
}
test("a fresh authenticated snapshot satisfies readiness without a core oracle cache", () => {
  assert.equal(assertV3L1Readiness(snapshotFixture()).funded, 1);
  const withoutSnapshot = snapshotFixture(); delete withoutSnapshot.snapshot;
  assert.throws(() => assertV3L1Readiness(withoutSnapshot));
});
for (const [label, mutate] of [
  ["unauthenticated snapshot", s => { s[87] = 0; }],
  ["stale snapshot", s => { s.writeBigUInt64LE(1_700_000_000n - 11n, 69); }],
  ["wrong snapshot exponent", s => { s.writeInt32LE(5, 49); }],
  ["halted snapshot", s => { s[86] = 1; }],
  ["unsequenced snapshot", s => { s.writeBigUInt64LE(0n, 77); }],
  ["wide snapshot confidence", s => { s.writeBigUInt64LE(37_900_000n, 61); }],
]) test(`rejects ${label}`, () => { const x = snapshotFixture(); mutate(x.snapshot); assert.throws(() => assertV3L1Readiness(x)); });

// The snapshot must carry the core's own feed: Pyth (TSLA) or a reporter-priced market's reserved id.
for (const [label, mutate] of [
  ["a snapshot of another feed", x => { x.snapshot.writeUInt32LE(922, 44); }],
  ["a snapshot of another channel", x => { x.snapshot[48] = 1; }],
]) test(`rejects ${label}`, () => { const x = snapshotFixture(); mutate(x); assert.throws(() => assertV3L1Readiness(x)); });

test("a reporter-priced (pre-IPO) market is ready with its own reserved feed", () => {
  const x = snapshotFixture();
  x.core.writeUInt32LE(4_000_000_001, 246); x.core[250] = 4;
  x.snapshot.writeUInt32LE(4_000_000_001, 44); x.snapshot[48] = 4;
  assert.equal(assertV3L1Readiness(x).funded, 1);
});
