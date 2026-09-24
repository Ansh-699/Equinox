import { describe, expect, it } from "vitest";
import {
  INITIAL_EXECUTION_STATE,
  acceptErTrade,
  beginDelegation,
  beginRestoration,
  beginUndelegation,
  completeRestoration,
  decodeDelegationFields,
  finalizeCommit,
  isL1Committed,
  isWithdrawalDisplaySafe,
  observeCommitOnL1,
  observeErActive,
  reconcileFromL1,
  reconcileMarketExecutionStatus,
  recoverFromReconciliationError,
  scheduleCommit,
  type AccountReader,
  type DelegationFields,
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

/** Builds a real 500-byte market account buffer with the given fields at
 * their verified offsets (`FIELD_OFFSETS` in `execution-status.ts`,
 * cross-checked against `programs/equinox/src/state.rs` via
 * `core::mem::offset_of!`), rather than mocking the decoder. */
function marketAccountBytes(fields: Partial<DelegationFields>): Uint8Array {
  const bytes = new Uint8Array(500);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(262, BigInt(fields.globalEventSequence ?? 0), true);
  bytes[329] = fields.delegationStatus ?? 0;
  view.setBigUint64(330, BigInt(fields.expectedCommitSequence ?? 0), true);
  view.setBigUint64(338, BigInt(fields.lastCommittedSequence ?? 0), true);
  view.setBigUint64(428, BigInt(fields.delegationSequence ?? 0), true);
  bytes[448] = fields.pendingUndelegation ? 1 : 0;
  return bytes;
}

describe("decodeDelegationFields", () => {
  it("decodes every field from its verified byte offset", () => {
    const bytes = marketAccountBytes({
      globalEventSequence: 42, delegationStatus: 1, expectedCommitSequence: 3,
      lastCommittedSequence: 2, delegationSequence: 1, pendingUndelegation: true,
    });
    expect(decodeDelegationFields(bytes)).toEqual({
      globalEventSequence: 42, delegationStatus: 1, expectedCommitSequence: 3,
      lastCommittedSequence: 2, delegationSequence: 1, pendingUndelegation: true,
    });
  });
});

describe("reconcileFromL1", () => {
  it("bootstraps directly into er_active on a first observation of an already-delegated market", () => {
    const l1 = decodeDelegationFields(marketAccountBytes({ delegationStatus: 1, delegationSequence: 3, expectedCommitSequence: 5, lastCommittedSequence: 4 }));
    const state = reconcileFromL1(INITIAL_EXECUTION_STATE, l1, null, true);
    expect(state.status).toBe("er_active");
    expect(state.sequences.l1FinalizedCommitSequence).toBe(4);
  });

  it("bootstraps directly into restored on a first observation of a restored market", () => {
    const l1 = decodeDelegationFields(marketAccountBytes({ delegationStatus: 3, delegationSequence: 7 }));
    const state = reconcileFromL1(INITIAL_EXECUTION_STATE, l1, null, true);
    expect(state.status).toBe("restored");
  });

  it("bootstraps into er_accepted (not er_active) when the ER already shows advanced activity, and stays put on the next tick", () => {
    const l1 = decodeDelegationFields(marketAccountBytes({ delegationStatus: 1 }));
    const bootstrapped = reconcileFromL1(INITIAL_EXECUTION_STATE, l1, 77, true);
    expect(bootstrapped.status).toBe("er_accepted");
    expect(bootstrapped.sequences.erEventSequence).toBe(77);
    // The very next tick, over the same unchanged on-chain fields, must not
    // spuriously re-trigger a transition just because the bootstrap
    // under-seeded `erEventSequence` -- this was a real bug.
    const again = reconcileFromL1(bootstrapped, l1, 77, false);
    expect(again).toEqual(bootstrapped);
  });

  it("walks delegating -> er_active -> commit_finalized from a tracked baseline as on-chain fields advance", () => {
    let state = INITIAL_EXECUTION_STATE;
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1 })), null);
    expect(state.status).toBe("er_active");
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1 })), 10);
    expect(state.status).toBe("er_accepted");
    expect(state.sequences.erEventSequence).toBe(10);
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1, lastCommittedSequence: 1 })), 10);
    expect(state.status).toBe("commit_finalized");
    expect(state.sequences.l1FinalizedCommitSequence).toBe(1);
    // Never marks it committed from ER-only information -- only L1's own lastCommittedSequence moved it.
    expect(isL1Committed(state)).toBe(true);
  });

  it("never treats an ER-accepted trade as L1-committed even while walking through Delegated", () => {
    let state = reconcileFromL1(INITIAL_EXECUTION_STATE, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1 })), null);
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1 })), 5);
    expect(isL1Committed(state)).toBe(false);
    expect(isWithdrawalDisplaySafe(state)).toBe(false);
  });

  it("completes the full undelegation -> restoration cycle from a tracked baseline", () => {
    let state = reconcileFromL1(INITIAL_EXECUTION_STATE, decodeDelegationFields(marketAccountBytes({ delegationStatus: 1, lastCommittedSequence: 1 })), null);
    expect(state.status).toBe("commit_finalized");
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 2, delegationSequence: 2 })), null);
    expect(state.status).toBe("undelegating");
    state = reconcileFromL1(state, decodeDelegationFields(marketAccountBytes({ delegationStatus: 3, delegationSequence: 3 })), null);
    expect(state.status).toBe("restored");
    expect(isWithdrawalDisplaySafe(state)).toBe(true);
  });

  it("reports a reconciliation error rather than accepting an unexpected Undelegating observation", () => {
    const state = reconcileFromL1(INITIAL_EXECUTION_STATE, decodeDelegationFields(marketAccountBytes({ delegationStatus: 2 })), null);
    expect(state.status).toBe("reconciliation_error");
  });
});

describe("reconcileMarketExecutionStatus", () => {
  function reader(bytes: Uint8Array | null): AccountReader {
    let binary = "";
    if (bytes) for (const b of bytes) binary += String.fromCharCode(b);
    return { account: async () => ({ value: bytes ? { data: [btoa(binary), "base64"] } : null }) };
  }

  function memoryRepository() {
    const rows = new Map<string, { status: string; sequences: unknown; error: string | null }>();
    return {
      async get(marketPda: string) { return rows.get(marketPda) ?? null; },
      async set(marketPda: string, status: string, sequences: unknown, error: string | null) { rows.set(marketPda, { status, sequences, error }); },
      rows,
    };
  }

  it("reports unchanged when the L1 account does not exist yet", async () => {
    const repo = memoryRepository();
    const result = await reconcileMarketExecutionStatus("market-x", reader(null), reader(null), repo, 1000);
    expect(result.changed).toBe(false);
    expect(result.state).toEqual(INITIAL_EXECUTION_STATE);
  });

  it("reconciles from L1 alone when not currently delegated, without ever reading the ER account", async () => {
    const repo = memoryRepository();
    let erReads = 0;
    const er: AccountReader = { account: async () => { erReads += 1; return { value: null }; } };
    const l1 = reader(marketAccountBytes({ delegationStatus: 0 }));
    const result = await reconcileMarketExecutionStatus("market-y", l1, er, repo, 1000);
    expect(result.state.status).toBe("l1_only");
    expect(erReads).toBe(0);
  });

  it("reads the ER account for its own event sequence only while the market is ER-delegated, and persists the result", async () => {
    const repo = memoryRepository();
    const l1 = reader(marketAccountBytes({ delegationStatus: 1 }));
    const er = reader(marketAccountBytes({ globalEventSequence: 77 }));
    const result = await reconcileMarketExecutionStatus("market-z", l1, er, repo, 1000);
    expect(result.changed).toBe(true);
    expect(repo.rows.get("market-z")?.status).toBe("er_accepted");
    // A second reconciliation of the same, unchanged on-chain state is a no-op write.
    const second = await reconcileMarketExecutionStatus("market-z", l1, er, repo, 1001);
    expect(second.changed).toBe(false);
  });
});

describe("decodeDelegationFields on a V3 core", () => {
  it("reads the V3 offsets, not the V2 ones", () => {
    const bytes = new Uint8Array(4096);
    bytes.set(new TextEncoder().encode("STKMK003"));
    const view = new DataView(bytes.buffer);
    bytes[197] = 1;
    view.setBigUint64(198, 55n, true);
    view.setBigUint64(206, 54n, true);
    view.setBigUint64(148, 900n, true);
    expect(decodeDelegationFields(bytes)).toEqual({ delegationStatus: 1, delegationSequence: 54, expectedCommitSequence: 55, lastCommittedSequence: 54, pendingUndelegation: false, globalEventSequence: 900 });
  });
});
