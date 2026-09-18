"use client";

import { useEffect, useState } from "react";
import { decodeTraderSeat, type TraderSeatView } from "@/lib/positions";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 8_000;

/** Polls the market account and decodes seatIndex's TraderSeat client-side
 * (lib/positions.ts) -- no dedicated backend route exists for this yet
 * (workers/src/private-sessions.ts's decoder is built but never wired to
 * an HTTP/WS route), so this reads the same market account
 * useStockStreamProtocol's transport already fetches for L1 actions. */
export function usePosition(rpc: SolanaRpcTransport | null, marketAddress: string | null, seatIndex: number) {
  const [seat, setSeat] = useState<TraderSeatView | null>(null);
  const [reconciliationStatus, setReconciliationStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rpc || !marketAddress) return;
    let stopped = false;
    const poll = () => {
      rpc.market(marketAddress).then((market) => {
        if (stopped) return;
        setSeat(decodeTraderSeat(market.bytes, market.state.traderSeatOffset, seatIndex));
        setReconciliationStatus(market.state.reconciliationStatus);
        setError(null);
      }).catch((err: unknown) => {
        if (stopped) return;
        setError(err instanceof Error ? err.message : "Could not read position");
      });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [rpc, marketAddress, seatIndex]);

  return { seat, reconciliationStatus, error };
}
