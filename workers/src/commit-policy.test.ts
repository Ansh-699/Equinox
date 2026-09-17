import { describe, expect, it } from "vitest";
import { decideCommitAction, type CommitPolicyInputs } from "./commit-policy";

const base = (overrides: Partial<CommitPolicyInputs> = {}): CommitPolicyInputs => ({
  isDelegated: true,
  currentErSequence: 10,
  lastRequestedSequence: 5,
  lastConfirmedSequence: 5,
  openInterestChangedMaterially: false,
  fundingJustUpdated: false,
  liquidationJustHappened: false,
  marketJustHaltedOrCorpAction: false,
  withdrawalPending: false,
  undelegationPlanned: false,
  ...overrides,
});

describe("decideCommitAction", () => {
  it("skips when not delegated", () => {
    expect(decideCommitAction(base({ isDelegated: false })).action).toBe("skip");
  });

  it("skips (auto-commit observation only) when the sequence is already covered by the automatic cadence and there is no explicit trigger", () => {
    const decision = decideCommitAction(base({ currentErSequence: 10, lastRequestedSequence: 5, lastConfirmedSequence: 10 }));
    expect(decision.action).toBe("observe-only");
  });

  it("does not duplicate a commit for a sequence already requested", () => {
    expect(decideCommitAction(base({ currentErSequence: 5, lastRequestedSequence: 5 })).action).toBe("skip");
  });

  it("triggers an explicit commit on a material open-interest change", () => {
    expect(decideCommitAction(base({ openInterestChangedMaterially: true })).action).toBe("explicit-commit");
  });

  it("triggers an explicit commit after a funding update", () => {
    expect(decideCommitAction(base({ fundingJustUpdated: true })).action).toBe("explicit-commit");
  });

  it("triggers an explicit commit after a liquidation", () => {
    expect(decideCommitAction(base({ liquidationJustHappened: true })).action).toBe("explicit-commit");
  });

  it("triggers an explicit commit on a market halt/corporate action", () => {
    expect(decideCommitAction(base({ marketJustHaltedOrCorpAction: true })).action).toBe("explicit-commit");
  });

  it("triggers an explicit commit for a pending withdrawal", () => {
    expect(decideCommitAction(base({ withdrawalPending: true })).action).toBe("explicit-commit");
  });

  it("commits and undelegates for a planned undelegation, even with an explicit trigger pending", () => {
    expect(decideCommitAction(base({ undelegationPlanned: true, liquidationJustHappened: true })).action).toBe("commit-and-undelegate");
  });

  it("does not duplicate an explicit trigger already requested", () => {
    expect(decideCommitAction(base({ liquidationJustHappened: true, currentErSequence: 5, lastRequestedSequence: 5 })).action).toBe("skip");
  });

  it("skips with no trigger and nothing yet confirmed beyond the requested sequence", () => {
    const decision = decideCommitAction(base({ currentErSequence: 10, lastRequestedSequence: 5, lastConfirmedSequence: 5 }));
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/waiting for the automatic commit cadence/);
  });
});
