import { describe, expect, it } from "vitest";
import { evaluateWithdrawGate } from "./use-withdraw";
import { deriveExecutionDisplay, type ExecutionStatusResponse } from "@/lib/execution-status";

const sequences = { erEventSequence: 0, erMarketStateSequence: 0, requestedCommitSequence: 0, l1ObservedCommitSequence: 0, l1FinalizedCommitSequence: 0, undelegationSequence: 0, restorationSequence: 0 };
const WITHDRAWAL_SAFE = new Set(["l1_only", "commit_finalized", "restored"]);
function display(status: ExecutionStatusResponse["status"]) {
  return deriveExecutionDisplay({ status, sequences, error: null, withdrawalDisplaySafe: WITHDRAWAL_SAFE.has(status) });
}

describe("evaluateWithdrawGate", () => {
  it("blocks when execution status is unavailable", () => {
    expect(evaluateWithdrawGate(null, null).allowed).toBe(false);
  });
  it("allows l1_only, commit_finalized and restored (the exact withdrawal-safe set)", () => {
    expect(evaluateWithdrawGate(display("l1_only"), 0).allowed).toBe(true);
    expect(evaluateWithdrawGate(display("commit_finalized"), 0).allowed).toBe(true);
    expect(evaluateWithdrawGate(display("restored"), 0).allowed).toBe(true);
  });
  it("blocks delegating, delegated (er_active/er_accepted), commit-pending, undelegating and restoration-pending", () => {
    for (const status of ["delegating", "er_active", "er_accepted", "commit_scheduled", "commit_observed_on_l1", "undelegating", "restoration_pending"] as const) {
      expect(evaluateWithdrawGate(display(status), 0).allowed).toBe(false);
    }
  });
  it("blocks on a reconciliation error status regardless of withdrawalSafe", () => {
    expect(evaluateWithdrawGate(display("reconciliation_error"), 0).allowed).toBe(false);
  });
  it("blocks on a reconciliation deficit (2) or recovery-required (3) status even when otherwise safe", () => {
    expect(evaluateWithdrawGate(display("l1_only"), 2).allowed).toBe(false);
    expect(evaluateWithdrawGate(display("l1_only"), 3).allowed).toBe(false);
    expect(evaluateWithdrawGate(display("l1_only"), 0).allowed).toBe(true);
    expect(evaluateWithdrawGate(display("l1_only"), 1).allowed).toBe(true); // SurplusDetected is not a deficit
  });
});
