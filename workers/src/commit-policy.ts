/**
 * Concrete MagicBlock commit-trigger policy (Priority 8, Section 10).
 *
 * The delegation program already auto-commits at the delegation-time
 * `commit_frequency_ms` (`lib/magicblock.ts::DELEGATION_COMMIT_FREQUENCY_MS`,
 * 30s) regardless of anything this Worker does. Submitting an explicit
 * `CommitMarket` every scheduler tick would just race the automatic commit
 * and waste the per-account commit fee (`docs/magicblock.md`). This module
 * decides whether an explicit trigger is actually warranted this tick, or
 * whether the tick should merely *observe* a sequence the automatic
 * cadence has already covered.
 */

export type CommitAction = "skip" | "observe-only" | "explicit-commit" | "commit-and-undelegate";

export interface CommitPolicyInputs {
  isDelegated: boolean;
  currentErSequence: number;
  /** Highest sequence this keeper has already requested a commit for (`CommitRecordRepository.lastRequestedSequence`). */
  lastRequestedSequence: number;
  /** Highest sequence already confirmed committed to L1 by *any* means, including the delegation program's own automatic cadence. */
  lastConfirmedSequence: number;
  openInterestChangedMaterially: boolean;
  fundingJustUpdated: boolean;
  liquidationJustHappened: boolean;
  marketJustHaltedOrCorpAction: boolean;
  withdrawalPending: boolean;
  undelegationPlanned: boolean;
}

export interface CommitDecision {
  action: CommitAction;
  reason: string;
}

export function decideCommitAction(inputs: CommitPolicyInputs): CommitDecision {
  if (!inputs.isDelegated) return { action: "skip", reason: "market is not delegated to an ephemeral rollup" };
  if (inputs.currentErSequence <= inputs.lastRequestedSequence) {
    return { action: "skip", reason: "no new ER sequence beyond what has already been requested" };
  }
  if (inputs.undelegationPlanned) return { action: "commit-and-undelegate", reason: "planned undelegation" };

  const explicitTriggerReason = inputs.marketJustHaltedOrCorpAction
    ? "market halt/corporate action"
    : inputs.withdrawalPending
      ? "pending withdrawal preparation"
      : inputs.liquidationJustHappened
        ? "liquidation occurred"
        : inputs.fundingJustUpdated
          ? "funding update occurred"
          : inputs.openInterestChangedMaterially
            ? "material open-interest change"
            : null;
  if (explicitTriggerReason) return { action: "explicit-commit", reason: explicitTriggerReason };

  if (inputs.currentErSequence <= inputs.lastConfirmedSequence) {
    return { action: "observe-only", reason: "sequence already covered by the automatic commit cadence; avoiding a duplicate explicit commit" };
  }
  return { action: "skip", reason: "no explicit trigger; waiting for the automatic commit cadence" };
}
