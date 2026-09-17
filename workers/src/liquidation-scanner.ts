import type { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";
import type { LiquidationCandidate } from "./keeper-jobs";
import { fetchAuthoritativeMarketAccountBytes, decodeMarketHeader } from "./market-state";
import { decodeTraderSeatProjection } from "./private-sessions";
import { isLiquidatable, partialLiquidationQuantity } from "./risk-model";

/**
 * Concrete liquidation candidate scanner (Priority 8, Section 8). A D1
 * projection may flag a seat as *likely* unhealthy, but per the module's
 * own documented rule (`keeper-jobs.ts::runLiquidationKeeperTick`'s doc
 * comment) it can never authorize a liquidation by itself -- every
 * candidate is re-read from the authoritative on-chain account and
 * re-scored with the exact `risk.rs` formula (`risk-model.ts`) before a
 * transaction is ever built.
 */

export interface LiquidationProjectionCandidate {
  seatIndex: number;
  /** The seat's `sequence` field as last observed by the projection --
   * used only to detect "this projection is stale, the seat has moved on
   * since" before spending an RPC round trip re-deriving health. */
  projectedSequence: bigint;
}

export interface BoundedCandidateSource {
  /** Returns up to `limit` likely-unhealthy candidates starting at `cursor` (opaque, caller-opaque pagination). */
  next(marketPda: string, cursor: string | null, limit: number): Promise<{ candidates: LiquidationProjectionCandidate[]; nextCursor: string | null }>;
}

export interface ReReadResult {
  isLiquidatable: boolean;
  oracleValid: boolean;
  quantity: bigint;
}

export type ReReadOutcome =
  | { status: "liquidatable"; result: ReReadResult }
  | { status: "healthy" | "already-progressed" | "stale-oracle" | "market-halted" | "not-found" };

/**
 * Re-reads one candidate's authoritative state and applies every required
 * gate: seat still exists and matches the projected sequence (otherwise
 * the position has already moved -- liquidated, closed, or re-opened --
 * since the projection was taken), oracle still valid, market mode still
 * permits liquidation (not fully halted), and the exact risk.rs health
 * check. Never trusts the projection's own "unhealthy" claim.
 */
export async function reReadLiquidationCandidate(
  transport: SolanaL1Transport | MagicRouterTransport,
  marketPda: string,
  candidate: LiquidationProjectionCandidate,
): Promise<ReReadOutcome> {
  const bytes = await fetchAuthoritativeMarketAccountBytes(transport, marketPda);
  if (!bytes) return { status: "not-found" };
  const header = decodeMarketHeader(bytes);
  if (!header) return { status: "not-found" };
  if (header.mode === 3 /* Emergency */) return { status: "market-halted" };
  const seat = decodeTraderSeatProjection(bytes, candidate.seatIndex);
  if (!seat) return { status: "not-found" };
  if (seat.sequence !== candidate.projectedSequence) return { status: "already-progressed" };
  if (!header.oracleValid) return { status: "stale-oracle" };

  const markPrice = header.lastVerifiedOraclePrice;
  const liquidatable = isLiquidatable(seat, markPrice, header.maintenanceMarginBps);
  if (!liquidatable) return { status: "healthy" };
  return {
    status: "liquidatable",
    result: { isLiquidatable: true, oracleValid: true, quantity: partialLiquidationQuantity(seat) },
  };
}

/** Deduplicates a page of projection candidates by seat index (a seat can
 * only ever have one outstanding liquidation decision per tick regardless
 * of how many projection rows reference it). */
export function dedupeCandidates(candidates: readonly LiquidationProjectionCandidate[]): LiquidationProjectionCandidate[] {
  const bySeat = new Map<number, LiquidationProjectionCandidate>();
  for (const candidate of candidates) bySeat.set(candidate.seatIndex, candidate);
  return [...bySeat.values()];
}

export function toKeeperCandidate(candidate: LiquidationProjectionCandidate): LiquidationCandidate {
  return { seatIndex: candidate.seatIndex };
}
