import { describe, expect, it } from "vitest";
import { deriveExecutionDisplay, fetchExecutionStatus, type ExecutionStatusResponse } from "./execution-status";

const sequences = {
  erEventSequence: 12,
  erMarketStateSequence: 12,
  requestedCommitSequence: 3,
  l1ObservedCommitSequence: 2,
  l1FinalizedCommitSequence: 2,
  undelegationSequence: 0,
  restorationSequence: 0,
};

function response(status: ExecutionStatusResponse["status"]): ExecutionStatusResponse {
  return { status, sequences, error: status === "reconciliation_error" ? "boom" : null, withdrawalDisplaySafe: status === "l1_only" };
}

describe("deriveExecutionDisplay", () => {
  it("l1_only: not delegated, no ER, withdrawal-safe status implied", () => {
    const display = deriveExecutionDisplay(response("l1_only"));
    expect(display).toMatchObject({ l1Connected: true, erConnected: false, marketDelegated: false, commitPending: false, restored: false, degraded: false });
  });
  it("er_active: delegated and ER-connected, no commit pending yet", () => {
    const display = deriveExecutionDisplay(response("er_active"));
    expect(display).toMatchObject({ erConnected: true, marketDelegated: true, commitPending: false });
  });
  it("commit_scheduled and commit_observed_on_l1 both read as commit-pending", () => {
    expect(deriveExecutionDisplay(response("commit_scheduled")).commitPending).toBe(true);
    expect(deriveExecutionDisplay(response("commit_observed_on_l1")).commitPending).toBe(true);
    expect(deriveExecutionDisplay(response("commit_finalized")).commitPending).toBe(false);
  });
  it("restoration_pending and restored are distinct, mutually exclusive flags", () => {
    expect(deriveExecutionDisplay(response("restoration_pending")).restorationPending).toBe(true);
    expect(deriveExecutionDisplay(response("restoration_pending")).restored).toBe(false);
    expect(deriveExecutionDisplay(response("restored")).restored).toBe(true);
    expect(deriveExecutionDisplay(response("restored")).restorationPending).toBe(false);
  });
  it("reconciliation_error surfaces as degraded and NOT l1Connected -- never displayed as a healthy state", () => {
    const display = deriveExecutionDisplay(response("reconciliation_error"));
    expect(display.degraded).toBe(true);
    expect(display.l1Connected).toBe(false);
  });
  it("carries the real ER and finalized-commit sequences through untouched", () => {
    const display = deriveExecutionDisplay(response("er_accepted"));
    expect(display.lastErSequence).toBe(12);
    expect(display.lastCommittedL1Sequence).toBe(2);
  });
});

describe("fetchExecutionStatus", () => {
  it("returns the parsed body on a 2xx response", async () => {
    const fetcher = (async () => new Response(JSON.stringify(response("er_active")), { status: 200 })) as typeof fetch;
    const result = await fetchExecutionStatus("https://api.test", "AAPL-PERP", fetcher);
    expect(result?.status).toBe("er_active");
  });
  it("returns null (never a fabricated status) on a non-2xx response", async () => {
    const fetcher = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect(await fetchExecutionStatus("https://api.test", "AAPL-PERP", fetcher)).toBeNull();
  });
  it("returns null on a network failure instead of throwing", async () => {
    const fetcher = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await fetchExecutionStatus("https://api.test", "AAPL-PERP", fetcher)).toBeNull();
  });
});
