"use client";

import { useEffect, useState } from "react";
import { classifyOpenOrdersResult, type OpenOrdersAdapter, type OpenOrdersViewState } from "@/lib/open-orders";

const POLL_INTERVAL_MS = 10_000;

/** Polls the selected open-orders adapter (lib/open-orders.ts). The terminal
 * selects the V3 shard adapter when a Worker/core is configured and retains a
 * fail-closed unavailable adapter when it is not. */
export function useOpenOrders(adapter: OpenOrdersAdapter, marketPda: string | null, seatIndex: number): OpenOrdersViewState {
  const [state, setState] = useState<OpenOrdersViewState>({ kind: "loading" });

  useEffect(() => {
    // No synchronous setState here for the !marketPda case -- see the pure
    // derivation on the return below (react-hooks/set-state-in-effect).
    if (!marketPda) return;
    let stopped = false;
    // Tracked locally (not broadcast via setState) so classifyOpenOrdersResult
    // has a "previous" to compare each poll against, without a synchronous
    // setState in the effect body -- the display only updates once the
    // first poll actually resolves, in the .then()/.catch() below.
    let current: OpenOrdersViewState = { kind: "loading" };

    const poll = () => {
      adapter.fetchOpenOrders({ marketPda, seatIndex })
        .then((result) => {
          if (stopped) return;
          current = classifyOpenOrdersResult(current, result);
          setState(current);
        })
        .catch((error: unknown) => {
          if (stopped) return;
          current = classifyOpenOrdersResult(current, null, error);
          setState(current);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [adapter, marketPda, seatIndex]);

  if (!marketPda) return { kind: "unavailable", reason: "No market configured." };
  return state;
}
