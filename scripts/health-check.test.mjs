/** evaluate() flags every outage mode seen on devnet, and stays quiet when healthy. */
import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./health-check.mjs";

const limits = { minSolKeeper: 1, minSolBot: 0.1, maxOracleAgeS: 30, maxPythAgeS: 120, maxTickAgeS: 30, maxCommitAgeS: 5400, skip: [] };
const now = 1_800_000_000_000;
const healthy = () => ({
  nowMs: now,
  status: { running: true, lastTickAt: now - 1000, marketOpen: true, markets: { "A-PERP": { reporter: {}, keeper: { lastCommitAt: now - 60_000 } } } },
  balances: { keeper: { address: "K", sol: 5 }, maker: { address: "M", sol: 1 }, taker: { address: "T", sol: 1 } },
  snapshots: { "A-PERP": now / 1000 - 4 },
});

test("healthy system has no problems", () => assert.deepEqual(evaluate(healthy(), limits), []));

test("each failure mode is reported", () => {
  const cases = {
    "not running": (h) => { h.status.running = false; },
    "last tick": (h) => { h.status.lastTickAt = now - 120_000; },
    "keeper wallet": (h) => { h.balances.keeper.sol = 0.000654; },
    "maker wallet": (h) => { h.balances.maker.sol = 0.01; },
    "oracle snapshot 117": (h) => { h.snapshots["A-PERP"] = now / 1000 - 117 * 3600; },
    "unreadable": (h) => { h.snapshots["A-PERP"] = null; },
    "rollup commit": (h) => { h.status.markets["A-PERP"].keeper.lastCommitAt = now - 9 * 24 * 3600_000; },
  };
  for (const [expected, mutate] of Object.entries(cases)) {
    const h = healthy(); mutate(h);
    assert.ok(evaluate(h, limits).some((p) => p.includes(expected.split(" ")[0] === "oracle" ? "oracle snapshot" : expected.split(" ")[0])), expected);
  }
});

test("a Pyth market is only checked while its session is open; reporter markets always", () => {
  const h = healthy();
  h.status.marketOpen = false;
  h.status.markets["T-PERP"] = { keeper: {} }; // Pyth-priced, no reporter
  h.snapshots["T-PERP"] = 1;
  assert.deepEqual(evaluate(h, limits), []);
  h.snapshots["A-PERP"] = 1; // reporter market, stale
  assert.equal(evaluate(h, limits).length, 1);
  // Pyth markets tolerate their ~30 s refresh cadence but not minutes of silence.
  const p = healthy();
  p.status.markets = { "T-PERP": { keeper: {} } };
  p.snapshots = { "T-PERP": now / 1000 - 60 };
  assert.deepEqual(evaluate(p, limits), []);
  p.snapshots["T-PERP"] = now / 1000 - 300;
  assert.equal(evaluate(p, limits).length, 1);
});

test("a null last commit (fresh restart) is unknown, and skipped markets are ignored", () => {
  const h = healthy();
  h.status.markets["A-PERP"].keeper.lastCommitAt = null;
  assert.deepEqual(evaluate(h, limits), []);
  h.snapshots["A-PERP"] = null;
  assert.deepEqual(evaluate(h, { ...limits, skip: ["A-PERP"] }), []);
});
