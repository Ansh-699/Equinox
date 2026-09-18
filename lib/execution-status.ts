/**
 * Client-side adapter for the Worker's already-decoded ER/L1 execution
 * status (workers/src/execution-status.ts, exposed at
 * GET /v1/markets/{symbol}/execution-status). This module never decodes
 * raw account bytes itself -- that reconciliation already happened
 * server-side, is unit-tested there, and duplicating it here would just
 * be a second place for the two to drift apart.
 */

export type MarketExecutionStatus =
  | "l1_only"
  | "delegating"
  | "er_active"
  | "er_accepted"
  | "commit_scheduled"
  | "commit_observed_on_l1"
  | "commit_finalized"
  | "undelegating"
  | "restoration_pending"
  | "restored"
  | "reconciliation_error";

export interface ExecutionSequences {
  erEventSequence: number;
  erMarketStateSequence: number;
  requestedCommitSequence: number;
  l1ObservedCommitSequence: number;
  l1FinalizedCommitSequence: number;
  undelegationSequence: number;
  restorationSequence: number;
}

export interface ExecutionStatusResponse {
  status: MarketExecutionStatus;
  sequences: ExecutionSequences;
  error: string | null;
  withdrawalDisplaySafe: boolean;
}

export interface ExecutionDisplayState {
  l1Connected: boolean;
  erConnected: boolean;
  marketDelegated: boolean;
  commitPending: boolean;
  restorationPending: boolean;
  restored: boolean;
  degraded: boolean;
  lastErSequence: number;
  lastCommittedL1Sequence: number;
}

const ER_LIFECYCLE_STATUSES: ReadonlySet<MarketExecutionStatus> = new Set([
  "delegating",
  "er_active",
  "er_accepted",
  "commit_scheduled",
  "commit_observed_on_l1",
  "commit_finalized",
  "undelegating",
]);

/** Pure mapping from the indexer's execution-status enum to the display
 * flags the UI needs -- kept separate from fetching so it's trivially
 * unit-testable against every enum value without a network mock. */
export function deriveExecutionDisplay(response: ExecutionStatusResponse): ExecutionDisplayState {
  return {
    l1Connected: response.status !== "reconciliation_error",
    erConnected: ER_LIFECYCLE_STATUSES.has(response.status),
    marketDelegated: ER_LIFECYCLE_STATUSES.has(response.status),
    commitPending: response.status === "commit_scheduled" || response.status === "commit_observed_on_l1",
    restorationPending: response.status === "restoration_pending",
    restored: response.status === "restored",
    degraded: response.status === "reconciliation_error",
    lastErSequence: response.sequences.erEventSequence,
    lastCommittedL1Sequence: response.sequences.l1FinalizedCommitSequence,
  };
}

/** Returns null on any non-2xx or network failure -- the caller shows a
 * "status unavailable" state rather than a stale or fabricated one. */
export async function fetchExecutionStatus(
  marketApiUrl: string,
  symbol: string,
  fetcher: typeof fetch = fetch,
): Promise<ExecutionStatusResponse | null> {
  try {
    const response = await fetcher(`${marketApiUrl}/v1/markets/${symbol}/execution-status`);
    if (!response.ok) return null;
    return (await response.json()) as ExecutionStatusResponse;
  } catch {
    return null;
  }
}
