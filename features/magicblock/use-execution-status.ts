"use client";

import { useEffect, useState } from "react";
import { deriveExecutionDisplay, fetchExecutionStatus, type ExecutionDisplayState } from "@/lib/execution-status";

const POLL_INTERVAL_MS = 5_000;
/** One slow or failed poll is not an outage: keep the last answer this long. */
const HOLD_LAST_GOOD_MS = 30_000;

/** Polls the indexer's execution-status endpoint. Returns null while
 * unconfigured/unavailable -- the caller must show an honest "unavailable"
 * state, never a guessed one. A single missed poll keeps the last answer
 * (at most 30 s old) so the book and seat don't blank out mid-deposit. */
export function useExecutionStatus(marketApiUrl: string | undefined, symbol: string): ExecutionDisplayState | null {
  const [display, setDisplay] = useState<ExecutionDisplayState | null>(null);

  useEffect(() => {
    if (!marketApiUrl) return;
    let stopped = false;
    let lastGoodAt = 0;
    // A new market must not show the previous one's status.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplay(null);
    const poll = () => {
      void fetchExecutionStatus(marketApiUrl, symbol).then((response) => {
        if (stopped) return;
        if (response) { lastGoodAt = Date.now(); setDisplay(deriveExecutionDisplay(response)); }
        else if (Date.now() - lastGoodAt > HOLD_LAST_GOOD_MS) setDisplay(null);
      });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [marketApiUrl, symbol]);

  return display;
}
