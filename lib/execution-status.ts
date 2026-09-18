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
  /** Which domain a session-signed order instruction must be routed to
   * right now, or null to refuse routing entirely (spec item 3: fail
   * closed, never invent a state not in MarketExecutionStatus). See
   * orderRoutingDomain() for the full state->domain mapping and why. */
  orderRoutingDomain: "l1" | "er" | null;
  /** The indexer's OWN authoritative display gate (workers/src/execution
   * -status.ts::isWithdrawalDisplaySafe / WITHDRAWAL_SAFE_STATUSES),
   * threaded through verbatim rather than re-derived here: it is not the
   * same predicate as `!marketDelegated` (commit_finalized is withdrawal-
   * safe even while still ER-delegated, because the market's L1 state is
   * fully caught up at that point) and re-deriving it independently would
   * risk silently drifting from the backend's own definition. The
   * on-chain program's own l1_withdrawals_allowed() remains the real
   * security boundary either way -- this is display-only. */
  withdrawalSafe: boolean;
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

// workers/src/execution-status.ts::reconcileFromL1 case 1 ("Delegated")
// covers er_active/er_accepted/commit_scheduled/commit_observed_on_l1/
// commit_finalized -- commit progress never by itself undelegates the
// account, so all five are genuinely ER-owned right now and an ER-domain
// order transaction is valid against them. "delegating" is the transient
// first-observed instant before that's confirmed, and "undelegating"/
// "restoration_pending" are the account actively changing owners --
// routing an order transaction to EITHER domain during any of those three
// could target an account that's no longer valid there. l1_only/restored
// are genuinely un-delegated (delegationStatus 0), so L1 is correct.
const ER_ORDER_ROUTABLE_STATUSES: ReadonlySet<MarketExecutionStatus> = new Set([
  "er_active",
  "er_accepted",
  "commit_scheduled",
  "commit_observed_on_l1",
  "commit_finalized",
]);
const L1_ORDER_ROUTABLE_STATUSES: ReadonlySet<MarketExecutionStatus> = new Set(["l1_only", "restored"]);

/** Fail-closed order-routing domain for the CURRENT status only -- every
 * value comes from the already-authoritative 11-state enum, never a
 * guessed or additional state. Returns null (refuse to route) for every
 * transitional or error status: delegating, undelegating,
 * restoration_pending, reconciliation_error. */
export function orderRoutingDomain(status: MarketExecutionStatus): "l1" | "er" | null {
  if (L1_ORDER_ROUTABLE_STATUSES.has(status)) return "l1";
  if (ER_ORDER_ROUTABLE_STATUSES.has(status)) return "er";
  return null;
}

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
    withdrawalSafe: response.withdrawalDisplaySafe,
    orderRoutingDomain: orderRoutingDomain(response.status),
  };
}

/** Single rendering boundary for the MagicBlock/execution-status label --
 * used by both components/layout/status-strip.tsx's ExecutionStatusBanner
 * and features/activity/activity-view.tsx's "ER / L1 commit status" panel,
 * so the two pages never independently drift into describing the same
 * underlying state two different (and possibly inconsistent) ways. Never
 * fabricates a label when `display` is null -- "unavailable" is honest,
 * not a guess. */
export function describeExecutionStatus(display: ExecutionDisplayState | null): string {
  if (!display) return "unavailable";
  if (display.degraded) return "reconciliation error";
  if (display.restorationPending) return "restoring";
  if (display.commitPending) return "commit pending";
  if (display.marketDelegated) return `ER active (seq ${display.lastErSequence})`;
  return "not delegated";
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
