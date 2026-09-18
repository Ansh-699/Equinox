import { describe, expect, it } from "vitest";
import { evaluateSessionActionGate } from "./use-session-order";
import { SESSION_ACTION, type SessionStatus } from "@/lib/browser-session";
import { deriveExecutionDisplay, type ExecutionStatusResponse } from "@/lib/execution-status";

const sequences = { erEventSequence: 0, erMarketStateSequence: 0, requestedCommitSequence: 0, l1ObservedCommitSequence: 0, l1FinalizedCommitSequence: 0, undelegationSequence: 0, restorationSequence: 0 };
function display(status: ExecutionStatusResponse["status"]) {
  return deriveExecutionDisplay({ status, sequences, error: null, withdrawalDisplaySafe: false });
}

const NOW = Math.floor(Date.now() / 1000);
function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionPda: "session-pda",
    sessionSignerAddress: "signer",
    ownerWallet: "owner",
    marketPda: "market",
    seatIndex: 0,
    actions: SESSION_ACTION.all,
    expiresAt: NOW + 3600,
    maxOrderNotional: "1",
    maxCumulativeNotional: "1",
    maximumExposure: "1",
    maximumOpenOrders: 1,
    nextExpectedNonce: 0n,
    revoked: false,
    ...overrides,
  };
}

describe("evaluateSessionActionGate", () => {
  it("blocks with no session", () => {
    const gate = evaluateSessionActionGate(null, ["place"], display("l1_only"));
    expect(gate).toMatchObject({ allowed: false, result: { reason: "session_invalid" } });
  });

  it("blocks a revoked session", () => {
    const gate = evaluateSessionActionGate(session({ revoked: true }), ["place"], display("l1_only"));
    expect(gate).toMatchObject({ allowed: false, result: { reason: "session_revoked" } });
  });

  it("blocks an expired session", () => {
    const gate = evaluateSessionActionGate(session({ expiresAt: NOW - 1 }), ["place"], display("l1_only"));
    expect(gate).toMatchObject({ allowed: false, result: { reason: "session_expired" } });
  });

  it("blocks an action bit the session was not authorized for", () => {
    const gate = evaluateSessionActionGate(session({ actions: SESSION_ACTION.cancel }), ["place"], display("l1_only"));
    expect(gate).toMatchObject({ allowed: false, result: { reason: "session_invalid" } });
  });

  it("blocks when execution status is unavailable -- never guesses a domain", () => {
    const gate = evaluateSessionActionGate(session(), ["place"], null);
    expect(gate).toMatchObject({ allowed: false, result: { reason: "execution_status_unavailable" } });
  });

  it("blocks routing during every transitional/error MagicBlock state", () => {
    for (const status of ["delegating", "undelegating", "restoration_pending", "reconciliation_error"] as const) {
      const gate = evaluateSessionActionGate(session(), ["place"], display(status));
      expect(gate).toMatchObject({ allowed: false, result: { reason: "er_transition_blocked" } });
    }
  });

  it("routes to l1 when the market is not delegated (l1_only, restored)", () => {
    for (const status of ["l1_only", "restored"] as const) {
      const gate = evaluateSessionActionGate(session(), ["place"], display(status));
      expect(gate).toMatchObject({ allowed: true, domain: "l1" });
    }
  });

  it("routes to er for every genuinely ER-delegated state", () => {
    for (const status of ["er_active", "er_accepted", "commit_scheduled", "commit_observed_on_l1", "commit_finalized"] as const) {
      const gate = evaluateSessionActionGate(session(), ["place"], display(status));
      expect(gate).toMatchObject({ allowed: true, domain: "er" });
    }
  });

  it("session and action checks are still enforced ahead of the execution-status gate", () => {
    // A revoked session must never get as far as reporting an ER-routing
    // reason -- session validity is checked first regardless of market state.
    const gate = evaluateSessionActionGate(session({ revoked: true }), ["place"], null);
    expect(gate).toMatchObject({ allowed: false, result: { reason: "session_revoked" } });
  });
});
