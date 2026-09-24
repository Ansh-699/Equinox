/** Priority 5, Section 6: ER/L1 execution-status reconciliation for the
 * indexer's own view of a market's delegation lifecycle.
 *
 * This is an INDEXER-side, informational model -- it answers "what should
 * the UI/API show as the market's current execution state" and "should the
 * indexer currently treat a withdrawal as displayable/safe". It is
 * deliberately NOT the security boundary: the actual enforcement of
 * "withdrawals are blocked while delegated" happens on-chain, in the Rust
 * program's own `DelegationStatus`/`l1_withdrawals_allowed()` (see
 * `programs/equinox/src/state.rs` and `docs/custody.md`). This module
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

/** Restoration confirmed: the market account is owned by Equinox on
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

// ---------------------------------------------------------------------
// Wiring this pure state machine to real on-chain reads
// (`chain-transports.ts`) and durable state
// (`repositories.ts::ExecutionStatusRepository`).
// ---------------------------------------------------------------------

/** Byte offsets within a Equinox market account's raw data, verified
 * against `programs/equinox/src/state.rs` via `core::mem::offset_of!`
 * (`reserved_upgrade` starts at 327; each `RESERVED_*` constant there is
 * relative to it). Mirrors `chain-transports.ts`'s own
 * `DELEGATION_STATUS_OFFSET` for the one field both modules need. */
const FIELD_OFFSETS = {
  globalEventSequence: 262,
  delegationStatus: 329,
  expectedCommitSequence: 330,
  lastCommittedSequence: 338,
  delegationSequence: 428,
  pendingUndelegation: 448,
} as const;

export interface DelegationFields {
  delegationStatus: number;
  delegationSequence: number;
  expectedCommitSequence: number;
  lastCommittedSequence: number;
  pendingUndelegation: boolean;
  globalEventSequence: number;
}

/** Pure decode of the raw account bytes -- no RPC, no trust decision beyond
 * "these are the bytes at these offsets" (the same boundary
 * `chain-transports.ts` draws for `classifyWritableAccountDomain`). */
/** V3 market cores (`STKMK003`, programs/equinox/src/v3.rs offsets). */
const V3_CORE_DISCRIMINATOR = "STKMK003";
const V3_OFFSETS = { globalEventSequence: 148, delegationStatus: 197, expectedCommitSequence: 198, lastCommittedSequence: 206 } as const;

export function decodeDelegationFields(bytes: Uint8Array): DelegationFields {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 214 && new TextDecoder().decode(bytes.subarray(0, 8)) === V3_CORE_DISCRIMINATOR) {
    const status = bytes[V3_OFFSETS.delegationStatus];
    const lastCommitted = Number(view.getBigUint64(V3_OFFSETS.lastCommittedSequence, true));
    return {
      delegationStatus: status,
      // V3 has no separate delegation counter; the commit sequence advances per cycle.
      delegationSequence: lastCommitted,
      expectedCommitSequence: Number(view.getBigUint64(V3_OFFSETS.expectedCommitSequence, true)),
      lastCommittedSequence: lastCommitted,
      pendingUndelegation: status === 2,
      globalEventSequence: Number(view.getBigUint64(V3_OFFSETS.globalEventSequence, true)),
    };
  }
  return {
    delegationStatus: bytes[FIELD_OFFSETS.delegationStatus],
    delegationSequence: Number(view.getBigUint64(FIELD_OFFSETS.delegationSequence, true)),
    expectedCommitSequence: Number(view.getBigUint64(FIELD_OFFSETS.expectedCommitSequence, true)),
    lastCommittedSequence: Number(view.getBigUint64(FIELD_OFFSETS.lastCommittedSequence, true)),
    pendingUndelegation: bytes[FIELD_OFFSETS.pendingUndelegation] !== 0,
    globalEventSequence: Number(view.getBigUint64(FIELD_OFFSETS.globalEventSequence, true)),
  };
}

/**
 * Drives the pure state machine above from authoritative decoded L1 fields
 * (always) and, when the market is currently ER-delegated, the ER's own
 * observed `globalEventSequence` (`erGlobalEventSequence`, `null` when not
 * applicable/not fetched). Never marks an ER-accepted trade as L1
 * committed: `l1.lastCommittedSequence` is the *only* signal this function
 * treats as commit progress, and it comes from the L1 account, never the
 * ER one.
 *
 * On a cold start (`state.status === "l1_only"`, this indexer's own
 * baseline for "never tracked this market's delegation history") and the
 * account is already mid-lifecycle, this snaps directly to the
 * corresponding status with sequences seeded from the L1 fields rather
 * than replaying every intermediate pure transition -- there is no prior
 * observed sequence to validate monotonicity against yet, so the strict
 * transition functions' "did this actually advance" checks do not apply.
 */
export function reconcileFromL1(state: ExecutionState, l1: DelegationFields, erGlobalEventSequence: number | null, isFirstObservation = false): ExecutionState {
  if (isFirstObservation && l1.delegationStatus !== 0) {
    return bootstrapFromL1(l1, erGlobalEventSequence);
  }
  switch (l1.delegationStatus) {
    case 0: // NotDelegated
      return state.status === "l1_only" ? state : { status: "l1_only", sequences: state.sequences };
    case 1: { // Delegated
      let next = state.status === "l1_only" || state.status === "restored" ? beginDelegation(state) : state;
      if (next.status === "delegating") next = observeErActive(next);
      if (next.status === "reconciliation_error") return next;
      if (erGlobalEventSequence !== null && erGlobalEventSequence > next.sequences.erEventSequence) {
        next = acceptErTrade(next, erGlobalEventSequence);
        if (next.status === "reconciliation_error") return next;
      }
      return reconcileCommitProgress(next, l1);
    }
    case 2: { // Undelegating
      if (state.status === "commit_finalized") return beginUndelegation(state, l1.delegationSequence);
      if (state.status === "undelegating" || state.status === "restoration_pending") return state;
      return errorState(state, `observed Undelegating on-chain from unexpected indexer status ${state.status}`);
    }
    case 3: { // Restored
      let next = state.status === "undelegating" ? beginRestoration(state) : state;
      if (next.status === "restoration_pending") next = completeRestoration(next, l1.delegationSequence || next.sequences.restorationSequence + 1);
      return next;
    }
    default:
      return errorState(state, `unrecognized on-chain delegation status ${l1.delegationStatus}`);
  }
}

function reconcileCommitProgress(state: ExecutionState, l1: DelegationFields): ExecutionState {
  if (l1.lastCommittedSequence <= state.sequences.l1FinalizedCommitSequence) return state;
  let next = state;
  if (l1.lastCommittedSequence > next.sequences.requestedCommitSequence) next = scheduleCommit(next, l1.lastCommittedSequence);
  if (next.status === "reconciliation_error") return next;
  next = observeCommitOnL1(next, l1.lastCommittedSequence);
  if (next.status === "reconciliation_error") return next;
  return finalizeCommit(next, l1.lastCommittedSequence);
}

function bootstrapFromL1(l1: DelegationFields, erGlobalEventSequence: number | null): ExecutionState {
  const erSequence = erGlobalEventSequence ?? 0;
  const sequences: ExecutionSequences = {
    erEventSequence: erSequence,
    erMarketStateSequence: erSequence,
    requestedCommitSequence: l1.expectedCommitSequence > 0 ? l1.expectedCommitSequence - 1 : 0,
    l1ObservedCommitSequence: l1.lastCommittedSequence,
    l1FinalizedCommitSequence: l1.lastCommittedSequence,
    undelegationSequence: l1.pendingUndelegation || l1.delegationStatus === 2 ? l1.delegationSequence : 0,
    restorationSequence: l1.delegationStatus === 3 ? l1.delegationSequence : 0,
  };
  // Seeding `erEventSequence` from the live ER read (rather than always 0)
  // is what makes a cold-start bootstrap idempotent against the very next
  // normal reconciliation tick over the same, unchanged on-chain state --
  // otherwise that next tick would see `erGlobalEventSequence >
  // sequences.erEventSequence` and spuriously walk the state machine to
  // "er_accepted" purely as an artifact of the bootstrap having under-seeded it.
  const status: MarketExecutionStatus =
    l1.delegationStatus === 1 ? (erSequence > 0 ? "er_accepted" : "er_active") : l1.delegationStatus === 2 ? "undelegating" : "restored";
  return { status, sequences };
}

/** Minimal surface this orchestration needs from the L1/ER transports --
 * matches `SolanaL1Transport`/`MagicRouterTransport`'s real `account()`
 * method shape without importing the transport classes themselves (this
 * module stays usable from a plain unit test with a hand-written fake). */
export interface AccountReader {
  account(address: string): Promise<{ value: { data: [string, string] | null } | null }>;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface ReconciliationResult {
  state: ExecutionState;
  changed: boolean;
}

/**
 * Full reconciliation for one market: reads the L1 account (authoritative
 * for delegation status and commit progress), reads the ER account too
 * when the L1 status indicates the market is currently ER-delegated
 * (`Delegated` or `Undelegating` -- reading it otherwise would just hit a
 * closed/foreign account), decodes both, and drives `reconcileFromL1`
 * from the persisted prior state (or a first-observation bootstrap when
 * none exists yet). Persists the result and reports whether it actually
 * changed, so a caller knows whether to publish it anywhere.
 */
export async function reconcileMarketExecutionStatus(
  marketPda: string,
  l1: AccountReader,
  er: AccountReader,
  repository: { get(marketPda: string): Promise<{ status: string; sequences: unknown; error: string | null } | null>; set(marketPda: string, status: string, sequences: unknown, error: string | null, now: number): Promise<void> },
  now: number,
): Promise<ReconciliationResult> {
  const persisted = await repository.get(marketPda);
  const state: ExecutionState = persisted
    ? { status: persisted.status as MarketExecutionStatus, sequences: persisted.sequences as ExecutionSequences, error: persisted.error ?? undefined }
    : INITIAL_EXECUTION_STATE;

  const l1Account = await l1.account(marketPda);
  if (!l1Account.value?.data) {
    // The market account doesn't exist on L1 at all (not yet created,
    // or -- mid-ER-delegation -- genuinely closed there). Neither case is
    // this function's to resolve; report unchanged rather than guessing.
    return { state, changed: false };
  }
  const l1Fields = decodeDelegationFields(decodeBase64(l1Account.value.data[0]));

  let erGlobalEventSequence: number | null = null;
  if (l1Fields.delegationStatus === 1 || l1Fields.delegationStatus === 2) {
    const erAccount = await er.account(marketPda);
    if (erAccount.value?.data) erGlobalEventSequence = decodeDelegationFields(decodeBase64(erAccount.value.data[0])).globalEventSequence;
  }

  const next = reconcileFromL1(state, l1Fields, erGlobalEventSequence, persisted === null);
  const changed = persisted === null || next.status !== state.status || JSON.stringify(next.sequences) !== JSON.stringify(state.sequences);
  if (changed) await repository.set(marketPda, next.status, next.sequences, next.error ?? null, now);
  return { state: next, changed };
}
