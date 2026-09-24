import type { MarketState } from "./market-state";

/**
 * Concrete funding-input source (Priority 8, Section 7).
 *
 * `programs/equinox/src/handlers.rs::update_funding` does not compute a
 * funding rate on-chain at all -- it only accepts a keeper-submitted
 * `(accumulator, timestamp)` pair and rejects anything that isn't
 * monotonically non-decreasing (`docs/risk.md`/`handlers.rs` verified). The
 * rate itself is, by design, an off-chain decision this source must make
 * deterministically from authoritative on-chain state (never an arbitrary
 * HTTP rate, never a UI projection).
 *
 * The optional `markPrice` argument is supplied by the validated V3 shard
 * aggregate when available. It intentionally falls back to the verified
 * index price for legacy/V2 callers, preserving a zero-premium baseline
 * rather than inventing a mark from untrusted bytes.
 */

export interface FundingPolicy {
  intervalMs: number;
  /** Maximum |funding rate| applied per interval, in bps of index price. */
  capBps: number;
  /** Matches `risk::FUNDING_SCALE` (1_000_000) -- the accumulator's fixed-point scale. */
  scale: bigint;
}

/** Deterministic, capped funding delta. `indexPrice`/`markPrice` are the
 * raw i128 on-chain price units (same scale as `last_verified_oracle_price`). */
export function computeCappedFundingDelta(indexPrice: bigint, markPrice: bigint, policy: FundingPolicy): bigint {
  if (indexPrice <= 0n) return 0n;
  const premiumBps = ((markPrice - indexPrice) * 10_000n) / indexPrice;
  const cap = BigInt(policy.capBps);
  const clamped = premiumBps > cap ? cap : premiumBps < -cap ? -cap : premiumBps;
  return (clamped * policy.scale) / 10_000n;
}

export type FundingMode = "open" | "close-only" | "paused";

export interface FundingTickDecision {
  eligible: boolean;
  reason: string;
  input?: {
    oracleValid: boolean;
    oracleTimestamp: number;
    lastFundingTimestamp: number;
    fundingIntervalMs: number;
    computeNextAccumulator: () => bigint;
    now: number;
  };
}

/** Full gate + input assembly for `runFundingKeeperTick`: fresh/valid
 * oracle, allowed market mode, and (redundantly with the tick's own check,
 * defense in depth) the configured interval having elapsed. Never reads
 * anything but the authoritative decoded market header. */
export function fundingTickDecision(market: MarketState, mode: FundingMode, policy: FundingPolicy, now: number, markPrice = market.lastVerifiedOraclePrice): FundingTickDecision {
  if (mode === "paused") return { eligible: false, reason: "market mode does not permit funding settlement (paused/emergency)" };
  if (!market.oracleValid) return { eligible: false, reason: "oracle not verified; refusing to settle funding on stale/invalid state" };
  const elapsedMs = now - Number(market.lastFundingTimestamp) * 1000;
  if (elapsedMs < policy.intervalMs) return { eligible: false, reason: `funding interval not yet elapsed (${elapsedMs}ms < ${policy.intervalMs}ms)` };
  return {
    eligible: true,
    reason: "funding interval elapsed with a fresh oracle",
    input: {
      oracleValid: market.oracleValid,
      oracleTimestamp: Number(market.lastVerifiedOracleTimestamp),
      lastFundingTimestamp: Number(market.lastFundingTimestamp),
      fundingIntervalMs: policy.intervalMs,
      computeNextAccumulator: () => market.fundingAccumulator + computeCappedFundingDelta(market.lastVerifiedOraclePrice, markPrice, policy),
      now,
    },
  };
}
