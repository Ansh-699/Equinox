/** Pure safety guards for the resumable V3 commit runner. */
export function validateCheckpoint(checkpoint, mode, accounts) {
  if (!checkpoint || checkpoint.version !== 1 || !Number.isInteger(checkpoint.next) || checkpoint.next < 0 || checkpoint.next > accounts.length) {
    throw new Error("invalid V3 sharded checkpoint header");
  }
  if (!Array.isArray(checkpoint.events) || checkpoint.events.length !== checkpoint.next) {
    throw new Error("V3 sharded checkpoint event count does not match next index");
  }
  checkpoint.events.forEach((event, index) => {
    if (event.index !== index || event.child !== accounts[index].toBase58() || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new Error(`V3 sharded checkpoint mismatch at child ${index}`);
    }
  });
  if (checkpoint.complete && checkpoint.next !== accounts.length) throw new Error("complete V3 sharded checkpoint has unfinished children");
  if (checkpoint.mode && checkpoint.mode !== mode) throw new Error("V3 sharded checkpoint mode mismatch");
}

export function validateV3CoreBytes(coreBytes) {
  if (!coreBytes || coreBytes.length !== 4_096 || Buffer.from(coreBytes).subarray(0, 8).toString() !== "STKMK003" || coreBytes.readUInt16LE(8) !== 3) {
    throw new Error("resolved ER core is not a V3 MarketCore account");
  }
}

/** The core's expected-commit cursor is the linearization point for the
 * sharded runner. Every child intent must observe the cursor for its own
 * epoch; this prevents a resumed process from submitting into an interleaved
 * or stale bundle after an operator/validator-side state change. */
export function validateV3CommitEpoch(coreBytes, expectedSequence) {
  validateV3CoreBytes(coreBytes);
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
    throw new Error("invalid V3 commit epoch");
  }
  const actual = Number(coreBytes.readBigUInt64LE(198));
  if (actual !== expectedSequence) throw new Error(`V3 commit epoch mismatch: expected ${expectedSequence}, observed ${actual}`);
}

/** Exercises the runner's durable checkpoint contract across every possible
 * interruption point. This is intentionally pure: it models a process dying
 * after child `crashAt - 1`, then reconstructing its next index and resuming
 * the remaining children without replaying or reordering any child. */
export function validateCrashResumeCoverage(accounts, mode = "commit") {
  if (!Array.isArray(accounts) || accounts.length !== 26) throw new Error("V3 crash coverage requires all 26 children");
  for (let crashAt = 0; crashAt <= accounts.length; crashAt += 1) {
    const events = accounts.slice(0, crashAt).map((account, index) => ({ index, child: account.toBase58(), sequence: 100 + index }));
    const interrupted = { version: 1, mode, next: crashAt, events, complete: false };
    validateCheckpoint(interrupted, mode, accounts);
    const resumedEvents = [...events];
    for (let index = crashAt; index < accounts.length; index += 1) {
      resumedEvents.push({ index, child: accounts[index].toBase58(), sequence: 100 + index });
    }
    validateCheckpoint({ version: 1, mode, next: accounts.length, events: resumedEvents, complete: true }, mode, accounts);
  }
  return true;
}
