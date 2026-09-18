"use client";

import { useEffect, useState } from "react";
import { deriveExecutionDisplay, fetchExecutionStatus, type ExecutionDisplayState } from "@/lib/execution-status";

const POLL_INTERVAL_MS = 5_000;

/** Polls the indexer's execution-status endpoint. Returns null while
 * unconfigured/unavailable -- the caller must show an honest "unavailable"
 * state, never a guessed or stale one. */
export function useExecutionStatus(marketApiUrl: string | undefined, symbol: string): ExecutionDisplayState | null {
  const [display, setDisplay] = useState<ExecutionDisplayState | null>(null);

  useEffect(() => {
    if (!marketApiUrl) return;
    let stopped = false;
    const poll = () => {
      void fetchExecutionStatus(marketApiUrl, symbol).then((response) => {
        if (stopped) return;
        setDisplay(response ? deriveExecutionDisplay(response) : null);
      });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [marketApiUrl, symbol]);

  return display;
}
