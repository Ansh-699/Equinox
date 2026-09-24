"use client";

import { useEffect, useState } from "react";
import { decodeOracleSnapshotV3 } from "@/clients/equinox/src";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 10_000;

export interface MarketClock {
  oracleValid: boolean;
  /** Unix seconds. The program's own "now" for order/session expiry is
   * this value, not wall-clock -- see handlers.rs::place_order_core /
   * authorize_trading_session, both of which read
   * header.last_verified_oracle_timestamp directly. */
  lastVerifiedOracleTimestamp: bigint;
  /** Present when read from the V3 OracleSnapshotV3 (authenticated Pyth). */
  oracle?: { price: number; confidence: number; tradingOpen: boolean; sequence: bigint };
}

/** Polls the oracle-anchored clock the program actually uses for expiry
 * comparisons: the V3 OracleSnapshotV3 when configured, otherwise the V2
 * market header. Returns null while unavailable -- callers must not fall
 * back to wall-clock and silently mismatch the on-chain check. */
export function useMarketClock(rpc: SolanaRpcTransport | null, marketAddress: string | null, snapshotAddress = ""): MarketClock | null {
  const [clock, setClock] = useState<MarketClock | null>(null);

  useEffect(() => {
    if (!rpc || !marketAddress) return;
    let stopped = false;
    const read = async (): Promise<MarketClock> => {
      if (!snapshotAddress) {
        const market = await rpc.market(marketAddress);
        return { oracleValid: market.state.oracleValid, lastVerifiedOracleTimestamp: market.state.lastVerifiedOracleTimestamp };
      }
      const snapshot = decodeOracleSnapshotV3(await rpc.accountBytes(snapshotAddress));
      // A snapshot bound to another market is never this market's clock.
      if (snapshot.core.toBase58() !== marketAddress) throw new Error("oracle snapshot belongs to a different market");
      const scale = 10 ** snapshot.exponent;
      return {
        oracleValid: snapshot.authenticated,
        lastVerifiedOracleTimestamp: snapshot.publishTimestamp,
        oracle: { price: Number(snapshot.price) * scale, confidence: Number(snapshot.confidence) * scale, tradingOpen: snapshot.tradingStatus === 0, sequence: snapshot.sequence },
      };
    };
    const poll = () => { read().then((next) => { if (!stopped) setClock(next); }).catch(() => { if (!stopped) setClock(null); }); };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [rpc, marketAddress, snapshotAddress]);

  return clock;
}
