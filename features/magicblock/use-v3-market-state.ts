"use client";

import { useEffect, useState } from "react";

export interface V3MarketReadiness {
  state: "not_configured" | "loading" | "available" | "unavailable";
  completeExecutionState: boolean;
  withdrawalReady: boolean;
}

/** Reads the Worker's atomic V3 aggregate. A failed/partial read is never
 * converted into a ready state; callers can safely render this as status only. */
export function useV3MarketState(marketApiUrl: string | undefined, core: string | undefined): V3MarketReadiness {
  const configured = Boolean(marketApiUrl && core);
  const [status, setStatus] = useState<V3MarketReadiness>({
    state: configured ? "loading" : "not_configured",
    completeExecutionState: false,
    withdrawalReady: false,
  });

  useEffect(() => {
    if (!marketApiUrl || !core) return;
    let stopped = false;
    void fetch(`${marketApiUrl.replace(/\/$/, "")}/v1/v3/markets/${encodeURIComponent(core)}?domain=l1`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ completeExecutionState?: boolean; withdrawalReady?: boolean }>;
      })
      .then((aggregate) => {
        if (stopped) return;
        setStatus(aggregate ? {
          state: "available",
          completeExecutionState: aggregate.completeExecutionState === true,
          withdrawalReady: aggregate.withdrawalReady === true,
        } : { state: "unavailable", completeExecutionState: false, withdrawalReady: false });
      })
      .catch(() => {
        if (!stopped) setStatus({ state: "unavailable", completeExecutionState: false, withdrawalReady: false });
      });
    return () => { stopped = true; };
  }, [marketApiUrl, core]);

  return configured ? status : { state: "not_configured", completeExecutionState: false, withdrawalReady: false };
}
