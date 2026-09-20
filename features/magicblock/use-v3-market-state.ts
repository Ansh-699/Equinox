"use client";

import { useEffect, useState } from "react";

export interface V3MarketReadiness {
  state: "not_configured" | "loading" | "available" | "unavailable";
  completeExecutionState: boolean;
  withdrawalReady: boolean;
  bookPageCount: number;
  seatShardCount: number;
  eventShardCount: number;
  positionCount: number;
  eventCount: number;
  delegationStatus: number | null;
  expectedCommitSequence: bigint | null;
  lastCommittedSequence: bigint | null;
}

export interface V3AggregateSummaryInput {
  completeExecutionState?: unknown;
  withdrawalReady?: unknown;
  bookPages?: unknown;
  seatShards?: unknown;
  eventShards?: unknown;
  positions?: unknown;
  core?: { delegationStatus?: unknown; expectedCommitSequence?: unknown; lastCommittedSequence?: unknown };
}

const emptySummary = (): Omit<V3MarketReadiness, "state"> => ({
  completeExecutionState: false, withdrawalReady: false, bookPageCount: 0, seatShardCount: 0,
  eventShardCount: 0, positionCount: 0, eventCount: 0, delegationStatus: null,
  expectedCommitSequence: null, lastCommittedSequence: null,
});

function bigintOrNull(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

/** Converts the Worker JSON aggregate into a bounded, display-safe summary.
 * Unknown/malformed fields are ignored; readiness booleans are only accepted
 * when the Worker explicitly returns `true`. */
export function summarizeV3Aggregate(input: V3AggregateSummaryInput): Omit<V3MarketReadiness, "state"> {
  const summary = emptySummary();
  summary.completeExecutionState = input.completeExecutionState === true;
  summary.withdrawalReady = input.withdrawalReady === true;
  summary.bookPageCount = Array.isArray(input.bookPages) ? input.bookPages.length : 0;
  summary.seatShardCount = Array.isArray(input.seatShards) ? input.seatShards.length : 0;
  summary.eventShardCount = Array.isArray(input.eventShards) ? input.eventShards.length : 0;
  summary.positionCount = Array.isArray(input.positions) ? input.positions.length : 0;
  if (Array.isArray(input.eventShards)) {
    summary.eventCount = input.eventShards.reduce((count, shard) => {
      if (!shard || typeof shard !== "object" || !("records" in shard) || !Array.isArray(shard.records)) return count;
      return count + shard.records.filter(Boolean).length;
    }, 0);
  }
  if (input.core && typeof input.core.delegationStatus === "number" && Number.isInteger(input.core.delegationStatus)) summary.delegationStatus = input.core.delegationStatus;
  summary.expectedCommitSequence = bigintOrNull(input.core?.expectedCommitSequence);
  summary.lastCommittedSequence = bigintOrNull(input.core?.lastCommittedSequence);
  return summary;
}

/** Reads the Worker's atomic V3 aggregate. A failed/partial read is never
 * converted into a ready state; callers can safely render this as status only. */
export function useV3MarketState(marketApiUrl: string | undefined, core: string | undefined): V3MarketReadiness {
  const configured = Boolean(marketApiUrl && core);
  const [status, setStatus] = useState<V3MarketReadiness>({
    state: configured ? "loading" : "not_configured",
    ...emptySummary(),
  });

  useEffect(() => {
    if (!marketApiUrl || !core) return;
    let stopped = false;
    void fetch(`${marketApiUrl.replace(/\/$/, "")}/v1/v3/markets/${encodeURIComponent(core)}?domain=l1`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<V3AggregateSummaryInput>;
      })
      .then((aggregate) => {
        if (stopped) return;
        setStatus(aggregate ? { state: "available", ...summarizeV3Aggregate(aggregate) } : { state: "unavailable", ...emptySummary() });
      })
      .catch(() => {
        if (!stopped) setStatus({ state: "unavailable", ...emptySummary() });
      });
    return () => { stopped = true; };
  }, [marketApiUrl, core]);

  return configured ? status : { state: "not_configured", ...emptySummary() };
}
