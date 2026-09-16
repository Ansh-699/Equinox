/** Priority 5, Section 6: ER/L1 execution-status reconciliation for the
 * indexer's own view of a market's delegation lifecycle.
 *
 * This is an INDEXER-side, informational model -- it answers "what should
 * the UI/API show as the market's current execution state" and "should the
 * indexer currently treat a withdrawal as displayable/safe". It is
 * deliberately NOT the security boundary: the actual enforcement of
 * "withdrawals are blocked while delegated" happens on-chain, in the Rust
 * program's own `DelegationStatus`/`l1_withdrawals_allowed()` (see
 * `programs/stockstream/src/state.rs` and `docs/custody.md`). This module
 * exists so the indexer never *displays* ER-accepted state as if it were
 * L1-committed truth, and never advances its own view on a sequence that
 * doesn't follow monotonically from what it already observed.
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

export interface ExecutionState {
  status: MarketExecutionStatus;
  sequences: ExecutionSequences;
  /** Set only when `status === "reconciliation_error"`; the reason a
   * transition was refused rather than silently accepted. */
  error?: string;
}

export const INITIAL_EXECUTION_STATE: ExecutionState = {
  status: "l1_only",
  sequences: {
    erEventSequence: 0,
    erMarketStateSequence: 0,
    requestedCommitSequence: 0,
    l1ObservedCommitSequence: 0,
    l1FinalizedCommitSequence: 0,
    undelegationSequence: 0,
    restorationSequence: 0,
  },
};

function errorState(state: ExecutionState, message: string): ExecutionState {
  return { ...state, status: "reconciliation_error", error: message };
}

/** A market's own base-layer `DelegateMarket` instruction succeeded. */
export function beginDelegation(state: ExecutionState): ExecutionState {
  if (state.status !== "l1_only" && state.status !== "restored") return errorState(state, `cannot delegate from ${state.status}`);
  return { status: "delegating", sequences: state.sequences };
}

/** The ER has cloned the delegated account and is processing transactions
 * for it. */
export function observeErActive(state: ExecutionState): ExecutionState {
  if (state.status !== "delegating" && state.status !== "er_active") return errorState(state, `cannot observe ER active from ${state.status}`);
  return { status: "er_active", sequences: state.sequences };
}

/** The ER accepted a trade at `erSequence`. ER state may run ahead of L1
 * by design -- this is expected, not an error -- but `erSequence` itself
 * must still move forward monotonically; a repeated or regressed sequence
 * means the indexer's own ER subscription delivered events out of order or
 * is watching two different ER sessions, which is a real defect. */
export function acceptErTrade(state: ExecutionState, erSequence: number): ExecutionState {
  if (!["er_active", "er_accepted", "commit_finalized"].includes(state.status))
    return errorState(state, `cannot accept an ER trade from ${state.status}`);
  if (erSequence <= state.sequences.erEventSequence) return errorState(state, `ER sequence ${erSequence} did not advance past ${state.sequences.erEventSequence}`);
  return { status: "er_accepted", sequences: { ...state.sequences, erEventSequence: erSequence, erMarketStateSequence: erSequence } };
}

/** A `CommitMarket`/`CommitAndUndelegate` was scheduled on the ER at
 * `commitSequence`. Real MagicBlock commits are strictly increasing per
 * market (`docs/magicblock.md`), so a repeated or regressed value is
 * rejected rather than silently accepted -- it would mean either a stale
 * replayed message or two commit schedulers racing on the same market. */
export function scheduleCommit(state: ExecutionState, commitSequence: number): ExecutionState {
  if (!["er_active", "er_accepted", "commit_finalized"].includes(state.status))
    return errorState(state, `cannot schedule a commit from ${state.status}`);
  if (commitSequence <= state.sequences.requestedCommitSequence) return errorState(state, `commit sequence ${commitSequence} did not advance past ${state.sequences.requestedCommitSequence}`);
  return { status: "commit_scheduled", sequences: { ...state.sequences, requestedCommitSequence: commitSequence } };
}

/** The base layer observed (but has not yet finalized) the scheduled
 * commit. `observedSequence` must equal the sequence this market actually
 * scheduled -- observing a *different* commit's sequence here would mean
 * the indexer is reading a stale or wrong L1 account, and must never be
 * treated as confirmation for a commit this market didn't request. */
export function observeCommitOnL1(state: ExecutionState, observedSequence: number): ExecutionState {
  if (state.status !== "commit_scheduled" && state.status !== "commit_observed_on_l1") return errorState(state, `cannot observe a commit from ${state.status}`);
  if (observedSequence !== state.sequences.requestedCommitSequence) return errorState(state, `observed commit ${observedSequence} does not match requested ${state.sequences.requestedCommitSequence} (stale L1 read?)`);
  if (observedSequence <= state.sequences.l1ObservedCommitSequence && state.status === "commit_observed_on_l1") return state; // idempotent re-observation
  return { status: "commit_observed_on_l1", sequences: { ...state.sequences, l1ObservedCommitSequence: observedSequence } };
}

/** The observed commit reached L1 finality. */
export function finalizeCommit(state: ExecutionState, finalizedSequence: number): ExecutionState {
  if (state.status !== "commit_observed_on_l1" && state.status !== "commit_finalized") return errorState(state, `cannot finalize a commit from ${state.status}`);
  if (finalizedSequence !== state.sequences.l1ObservedCommitSequence) return errorState(state, `finalized commit ${finalizedSequence} does not match observed ${state.sequences.l1ObservedCommitSequence}`);
  return { status: "commit_finalized", sequences: { ...state.sequences, l1FinalizedCommitSequence: finalizedSequence } };
}

/** `CommitAndUndelegate` was scheduled: the market is leaving the ER.
 * Requires the prior commit to already be finalized -- undelegating on top
 * of an unfinalized commit would abandon ER state L1 never actually saw. */
export function beginUndelegation(state: ExecutionState, undelegationSequence: number): ExecutionState {
  if (state.status !== "commit_finalized") return errorState(state, `cannot undelegate from ${state.status} (commit must be finalized first)`);
  if (undelegationSequence <= state.sequences.undelegationSequence) return errorState(state, `undelegation sequence ${undelegationSequence} did not advance`);
  return { status: "undelegating", sequences: { ...state.sequences, undelegationSequence } };
}

/** The delegation program's external-undelegate callback fired; restoring
 * L1 ownership is in flight but not yet confirmed. */
export function beginRestoration(state: ExecutionState): ExecutionState {
  if (state.status !== "undelegating" && state.status !== "restoration_pending") return errorState(state, `cannot begin restoration from ${state.status}`);
  return { status: "restoration_pending", sequences: state.sequences };
}

/** Restoration confirmed: the market account is owned by StockStream on
 * L1 again and `restorationSequence` must have actually advanced -- a
 * restoration event that doesn't move this counter is either a duplicate
 * or a forged/replayed callback, not a fresh confirmation. */
export function completeRestoration(state: ExecutionState, restorationSequence: number): ExecutionState {
  if (state.status !== "restoration_pending") return errorState(state, `cannot complete restoration from ${state.status}`);
  if (restorationSequence <= state.sequences.restorationSequence) return errorState(state, `restoration sequence ${restorationSequence} did not advance`);
  return { status: "restored", sequences: { ...state.sequences, restorationSequence } };
}

/** Explicit governed recovery from a reconciliation error: resets to the
 * last known-safe status (`l1_only` or `restored`) with sequences intact,
 * for a human/keeper decision to re-derive from there -- never automatic. */
export function recoverFromReconciliationError(state: ExecutionState, to: "l1_only" | "restored"): ExecutionState {
  if (state.status !== "reconciliation_error") return errorState(state, `not in an error state (${state.status})`);
  return { status: to, sequences: state.sequences };
}

const WITHDRAWAL_SAFE_STATUSES: ReadonlySet<MarketExecutionStatus> = new Set(["l1_only", "commit_finalized", "restored"]);

/** The indexer-side display/UX gate only -- see the module doc. */
export function isWithdrawalDisplaySafe(state: ExecutionState): boolean {
  return WITHDRAWAL_SAFE_STATUSES.has(state.status);
}

/** ER state must never be shown to a user as L1-committed truth. */
export function isL1Committed(state: ExecutionState): boolean {
  return state.status === "l1_only" || state.status === "commit_finalized" || state.status === "restored";
}
