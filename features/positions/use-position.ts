"use client";

import { useEffect, useState } from "react";
import { decodeTraderSeat, type TraderSeatView } from "@/lib/positions";
import type { SolanaRpcTransport } from "@/lib/rpc-transport";

const POLL_INTERVAL_MS = 8_000;

interface V3PositionJson {
  shard?: unknown; slot?: unknown; trader?: unknown; availableCollateral?: unknown; reservedMargin?: unknown;
  basePosition?: unknown; quoteEntryValue?: unknown; realizedPnl?: unknown;
  lastFundingAccumulator?: unknown; openBidExposure?: unknown; openAskExposure?: unknown;
  openOrderCount?: unknown; liquidationState?: unknown; sequence?: unknown;
}

interface V3AggregateJson { positions?: unknown; }

function bigintField(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

/** Converts one Worker V3 seat projection to the existing display model.
 * Every numeric field is validated; malformed aggregate data never becomes a
 * partially-populated position in the UI. */
export function decodeV3Position(value: unknown, seatIndex: number): TraderSeatView | null {
  if (!value || typeof value !== "object") return null;
  const position = value as V3PositionJson;
  if (position.shard !== Math.floor(seatIndex / 32) || position.slot !== seatIndex % 32 || typeof position.trader !== "string" || typeof position.liquidationState !== "number" || !Number.isInteger(position.liquidationState)) return null;
  const fields = [position.availableCollateral, position.reservedMargin, position.basePosition, position.quoteEntryValue, position.realizedPnl, position.lastFundingAccumulator, position.openBidExposure, position.openAskExposure, position.sequence].map(bigintField);
  if (fields.some((field) => field === null) || typeof position.openOrderCount !== "number" || !Number.isSafeInteger(position.openOrderCount)) return null;
  const [availableCollateral, reservedMargin, basePosition, quoteEntryValue, realizedPnl, lastFundingAccumulator, openBidExposure, openAskExposure, sequence] = fields as bigint[];
  const liquidationState = (["healthy", "warning", "liquidatable", "bankrupt"] as const)[position.liquidationState] ?? "unknown";
  return { seatIndex, owner: position.trader, availableCollateral, reservedMargin, basePosition, quoteEntryValue, realizedPnl, lastFundingAccumulator, openBidExposure, openAskExposure, openOrderCount: position.openOrderCount, liquidationState, sequence };
}

/** Polls the market account and decodes seatIndex's TraderSeat client-side
 * (lib/positions.ts) -- no dedicated backend route exists for this yet
 * (workers/src/private-sessions.ts's decoder is built but never wired to
 * an HTTP/WS route), so this reads the same market account
 * useStockStreamProtocol's transport already fetches for L1 actions. */
export function usePosition(rpc: SolanaRpcTransport | null, marketAddress: string | null, seatIndex: number, v3?: { marketApiUrl?: string; core?: string }) {
  const [seat, setSeat] = useState<TraderSeatView | null>(null);
  const [reconciliationStatus, setReconciliationStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if ((!rpc || !marketAddress) && !(v3?.marketApiUrl && v3.core)) return;
    let stopped = false;
    const poll = () => {
      if (v3?.marketApiUrl && v3.core) {
        void fetch(`${v3.marketApiUrl.replace(/\/$/, "")}/v1/v3/markets/${encodeURIComponent(v3.core)}?domain=l1`)
          .then(async (response) => response.ok ? await response.json() as V3AggregateJson : null)
          .then((aggregate) => {
            if (stopped) return;
            const values = aggregate && Array.isArray(aggregate.positions) ? aggregate.positions : [];
            const position = values.find((value) => value && typeof value === "object" && "shard" in value && "slot" in value && (value as { shard?: unknown; slot?: unknown }).shard === Math.floor(seatIndex / 32) && (value as { slot?: unknown }).slot === seatIndex % 32);
            setSeat(decodeV3Position(position, seatIndex));
            setReconciliationStatus(null);
            setError(null);
          })
          .catch((err: unknown) => {
            if (!stopped) setError(err instanceof Error ? err.message : "Could not read V3 position");
          });
        return;
      }
      if (!rpc || !marketAddress) return;
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
  }, [rpc, marketAddress, seatIndex, v3?.marketApiUrl, v3?.core]);

  return { seat, reconciliationStatus, error };
}
