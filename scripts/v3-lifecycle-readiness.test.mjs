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
  ["wrong feed", x => { x.core.writeUInt32LE(922,246); }],
  ["wrong channel", x => { x.core[250]=1; }],
  ["wrong exponent", x => { x.core.writeInt32LE(-6,251); }],
  ["closed", x => { x.core[1686]=3; }],
  ["halted", x => { x.core[11]=0; }],
  ["restricted", x => { x.core[11]=2; }],
]) test(`rejects ${label}`, () => { const x=fixture();mutate(x);assert.throws(()=>assertV3L1Readiness(x)); });
