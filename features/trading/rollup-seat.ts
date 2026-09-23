import type { TraderSeatView } from "@/lib/positions";
import type { SeatPosition } from "./use-v3-book";

const LIQUIDATION = ["healthy", "warning", "liquidatable", "bankrupt"] as const;

/** The wallet's seat in the live bundle, as the terminal's TraderSeatView. */
export function seatFromPositions(positions: readonly SeatPosition[], wallet: string): { index: number; view: TraderSeatView } | null {
  const own = positions.find((p) => p.trader === wallet);
  if (!own) return null;
  const index = own.shard * 32 + own.slot;
  return {
    index,
    view: {
      seatIndex: index, owner: own.trader,
      availableCollateral: BigInt(own.availableCollateral), reservedMargin: BigInt(own.reservedMargin),
      basePosition: BigInt(own.basePosition), quoteEntryValue: BigInt(own.quoteEntryValue), realizedPnl: BigInt(own.realizedPnl),
      lastFundingAccumulator: 0n, openBidExposure: 0n, openAskExposure: 0n,
      openOrderCount: own.openOrderCount, liquidationState: LIQUIDATION[own.liquidationState] ?? "unknown", sequence: 0n,
    },
  };
}

/** First unoccupied seat index (V3 markets hold 128). */
export function firstFreeSeat(positions: readonly SeatPosition[]): number {
  const taken = new Set(positions.map((p) => p.shard * 32 + p.slot));
  for (let index = 0; index < 128; index += 1) if (!taken.has(index)) return index;
  return 0;
}
