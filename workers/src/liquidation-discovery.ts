import { decodeTraderSeatProjection } from "./private-sessions";
import { isLiquidatable } from "./risk-model";
import type { LiquidationProjectionCandidate } from "./liquidation-scanner";
import type { MarketState } from "./market-state";

/**
 * Bounded discovery of likely-unhealthy seats (Priority 8, Section 8),
 * scanning the trader-seat region directly out of the already-fetched
 * account bytes rather than a separate D1 projection table -- no
 * event-driven health-projection materializer exists yet, and scanning the
 * authoritative bytes the orchestrator already has in hand is strictly
 * more accurate than maintaining a second, derived index of the same
 * data. This is still only *discovery*: every candidate this returns is
 * re-read and re-scored independently
 * (`liquidation-scanner.ts::reReadLiquidationCandidate`) with a fresh fetch
 * before any liquidation transaction is built, so a race between this scan
 * and the moment of action is caught, not assumed away.
 */

const MAX_TRADER_SEATS = 128;

export interface LiquidationSweepResult {
  candidates: LiquidationProjectionCandidate[];
  nextCursor: number;
}

export function scanLiquidationCandidates(
  accountBytes: Uint8Array,
  header: MarketState,
  cursor: number,
  batchSize: number,
): LiquidationSweepResult {
  const candidates: LiquidationProjectionCandidate[] = [];
  const start = ((cursor % MAX_TRADER_SEATS) + MAX_TRADER_SEATS) % MAX_TRADER_SEATS;
  for (let i = 0; i < Math.min(batchSize, MAX_TRADER_SEATS); i += 1) {
    const seatIndex = (start + i) % MAX_TRADER_SEATS;
    const seat = decodeTraderSeatProjection(accountBytes, seatIndex);
    if (!seat) continue;
    if (header.oracleValid && isLiquidatable(seat, header.lastVerifiedOraclePrice, header.maintenanceMarginBps)) {
      candidates.push({ seatIndex, projectedSequence: seat.sequence });
    }
  }
  const nextCursor = (start + Math.min(batchSize, MAX_TRADER_SEATS)) % MAX_TRADER_SEATS;
  return { candidates, nextCursor };
}
