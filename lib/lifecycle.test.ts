import { describe, expect, it } from "vitest";
import { initialExecutionState, transition } from "./lifecycle";

describe("execution lifecycle", () => {
  it("requires L1 settlement before a withdrawal", () => {
    const deposited = transition(transition(initialExecutionState, "REQUEST_DEPOSIT"), "CONFIRM_DEPOSIT");
    const delegated = transition(transition(deposited, "REQUEST_SESSION"), "CONFIRM_DELEGATION");
    const requested = transition(delegated, "REQUEST_UNDELEGATE");
    expect(requested.phase).toBe("undelegating");
    expect(transition(requested, "UNDELEGATED").phase).toBe("withdraw_ready");
  });

  it("does not allow an L1 withdrawal during an active ER session", () => {
    const deposited = transition(transition(initialExecutionState, "REQUEST_DEPOSIT"), "CONFIRM_DEPOSIT");
    const delegated = transition(transition(deposited, "REQUEST_SESSION"), "CONFIRM_DELEGATION");
    expect(transition(delegated, "WITHDRAW").phase).toBe("delegated");
  });
});
