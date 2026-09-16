import { describe, expect, it } from "vitest";
import {
  INITIAL_EXECUTION_STATE,
  acceptErTrade,
  beginDelegation,
  beginRestoration,
  beginUndelegation,
  completeRestoration,
  finalizeCommit,
  isL1Committed,
  isWithdrawalDisplaySafe,
  observeCommitOnL1,
  observeErActive,
  recoverFromReconciliationError,
  scheduleCommit,
  type ExecutionState,
} from "./execution-status";

function delegate(): ExecutionState {
  return observeErActive(beginDelegation(INITIAL_EXECUTION_STATE));
}

describe("ER/L1 execution-status reconciliation", () => {
  it("lets ER state run ahead of L1 without ever marking it L1-committed", () => {
    const state = acceptErTrade(delegate(), 10);
    expect(state.status).toBe("er_accepted");
    expect(state.sequences.erEventSequence).toBe(10);
    expect(isL1Committed(state)).toBe(false);
    expect(isWithdrawalDisplaySafe(state)).toBe(false);
  });

  it("moves through commit scheduled -> observed -> finalized", () => {
    let state = acceptErTrade(delegate(), 1);
    state = scheduleCommit(state, 5);
    expect(state.status).toBe("commit_scheduled");
    state = observeCommitOnL1(state, 5);
    expect(state.status).toBe("commit_observed_on_l1");
    expect(isWithdrawalDisplaySafe(state)).toBe(false);
    state = finalizeCommit(state, 5);
    expect(state.status).toBe("commit_finalized");
    expect(isL1Committed(state)).toBe(true);
    expect(isWithdrawalDisplaySafe(state)).toBe(true);
  });

  it("handles multiple sequential commits, each strictly increasing, with ER trading continuing between them", () => {
    let state = finalizeCommit(observeCommitOnL1(scheduleCommit(acceptErTrade(delegate(), 1), 5), 5), 5);
    // Trading continues on the ER after the first commit finalizes --
    // periodic commits don't end an ER session.
    state = acceptErTrade(state, 2);
    expect(state.status).toBe("er_accepted");
    state = scheduleCommit(state, 6);
    state = observeCommitOnL1(state, 6);
    state = finalizeCommit(state, 6);
    expect(state.sequences.requestedCommitSequence).toBe(6);
    expect(state.sequences.l1FinalizedCommitSequence).toBe(6);
  });

  it("tolerates a delayed commit: staying in commit_scheduled until L1 observes it is not an error", () => {
    const scheduled = scheduleCommit(acceptErTrade(delegate(), 1), 5);
    expect(scheduled.status).toBe("commit_scheduled");
    // Re-observing "still scheduled" (no L1 read yet) is just staying put --
    // callers simply don't call observeCommitOnL1 until they have a read.
    expect(scheduled.status).not.toBe("reconciliation_error");
  });

  it("rejects a stale L1 read that references a different commit sequence than requested", () => {
    const scheduled = scheduleCommit(acceptErTrade(delegate(), 1), 5);
    const state = observeCommitOnL1(scheduled, 3); // stale: an older commit's sequence
    expect(state.status).toBe("reconciliation_error");
    expect(state.error).toMatch(/stale L1 read/);
  });

  it("requires undelegation to wait for a finalized commit, then tracks restoration", () => {
    let state = finalizeCommit(observeCommitOnL1(scheduleCommit(acceptErTrade(delegate(), 1), 5), 5), 5);
    state = beginUndelegation(state, 1);
    expect(state.status).toBe("undelegating");
    state = beginRestoration(state);
    expect(state.status).toBe("restoration_pending");
    expect(isWithdrawalDisplaySafe(state)).toBe(false);
    state = completeRestoration(state, 1);
    expect(state.status).toBe("restored");
    expect(isL1Committed(state)).toBe(true);
    expect(isWithdrawalDisplaySafe(state)).toBe(true);
  });

  it("rejects undelegation attempted before the commit is finalized", () => {
    const scheduled = scheduleCommit(acceptErTrade(delegate(), 1), 5);
    const state = beginUndelegation(scheduled, 1);
    expect(state.status).toBe("reconciliation_error");
  });

  it("flags a conflicting/regressed sequence as a reconciliation error instead of silently accepting it", () => {
    const advanced = acceptErTrade(delegate(), 10);
    const regressed = acceptErTrade(advanced, 10); // repeated, not advanced
    expect(regressed.status).toBe("reconciliation_error");
    expect(isWithdrawalDisplaySafe(regressed)).toBe(false);
  });

  it("only leaves reconciliation_error through an explicit, named governed recovery", () => {
    const advanced = acceptErTrade(delegate(), 10);
    const errored = acceptErTrade(advanced, 10);
    expect(errored.status).toBe("reconciliation_error");
    // A further ER event on the errored state stays errored -- it does not
    // self-heal.
    expect(acceptErTrade(errored, 20).status).toBe("reconciliation_error");
    const recovered = recoverFromReconciliationError(errored, "l1_only");
    expect(recovered.status).toBe("l1_only");
    expect(recovered.sequences).toEqual(errored.sequences);
  });
});
