"use client";

import { useEffect, useState } from "react";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 10_000;

export interface MarketClock {
  oracleValid: boolean;
  /** Unix seconds. The program's own "now" for order/session expiry is
   * this value, not wall-clock -- see handlers.rs::place_order_core /
   * authorize_trading_session, both of which read
   * header.last_verified_oracle_timestamp directly. */
  lastVerifiedOracleTimestamp: bigint;
}

/** Polls the market account for the oracle-anchored clock the program
 * actually uses for expiry comparisons. Returns null while unavailable --
 * callers must not fall back to wall-clock and silently mismatch the
 * on-chain check. */
export function useMarketClock(rpc: SolanaRpcTransport | null, marketAddress: string | null): MarketClock | null {
  const [clock, setClock] = useState<MarketClock | null>(null);

  useEffect(() => {
    if (!rpc || !marketAddress) return;
    let stopped = false;
    const poll = () => {
      rpc.market(marketAddress).then((market) => {
        if (stopped) return;
        setClock({ oracleValid: market.state.oracleValid, lastVerifiedOracleTimestamp: market.state.lastVerifiedOracleTimestamp });
      }).catch(() => { if (!stopped) setClock(null); });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [rpc, marketAddress]);

  return clock;
}
