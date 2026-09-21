/** Read-only tests for the current V3 resumable lifecycle runner. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stockstream-v3-runner-"));
const statePath = path.join(directory, "lifecycle.json");
const delegationPath = path.join(directory, "delegation.json");
const commitPath = path.join(directory, "commit.json");
const env = { ...process.env, V3_LIFECYCLE_STATE_PATH: statePath, V3_DELEGATION_STATE_PATH: delegationPath, V3_SHARDED_COMMIT_STATE_PATH: commitPath };
const run = () => JSON.parse(execFileSync(process.execPath, ["scripts/v3-devnet-lifecycle.mjs", "plan"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }));

try {
  fs.writeFileSync(statePath, "{}", { mode: 0o600 });
  let plan = run();
  assert.equal(plan.version, 3);
  assert.deepEqual(plan.oracle, { feedId: 922, channel: 2, channelName: "fixed_rate@50ms", exponent: -5, symbol: "Equity.US.AAPL/USD" });
  assert.match(plan.stages.setup, /pending/);
  assert.match(plan.stages.delegation, /pending/);
  assert.match(plan.stages.commit, /blocked\/pending/);

  fs.writeFileSync(statePath, JSON.stringify({ version: 3, setupComplete: true, core: "2CAPY57nPio7zVecnysbUss5cX7nRXfDrXg8v488Xqdh", v3Accounts: { bookPages: Array(18).fill("book"), seatShards: Array(4).fill("seat"), eventShards: Array(4).fill("event") } }), { mode: 0o600 });
  fs.writeFileSync(delegationPath, JSON.stringify({ complete: true }), { mode: 0o600 });
  plan = run();
  assert.match(plan.stages.setup, /complete/);
  assert.match(plan.stages.delegation, /complete/);
  assert.match(plan.stages.commit, /blocked\/pending/);

  for (const core of [
    "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso",
    "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei",
    "9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS",
  ]) {
    fs.writeFileSync(statePath, JSON.stringify({ version: 3, core }), { mode: 0o600 });
    assert.throws(run, /refusing preserved AAPL\/V2 market or core/);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("runner tests: OK (V3 resume, checkpoint stages, preserved-V2 guard)");
