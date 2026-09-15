export type MarketSession = "Regular" | "PreMarket" | "PostMarket" | "Overnight" | "Closed";
export type TradingStatus = "Open" | "Halted" | "CorpAction" | "Closed";
export interface OracleUpdate { feedId: string; channel: string; price: bigint; exponent: number; confidence: bigint; timestamp: number; session: MarketSession; status: TradingStatus; }
export interface OraclePolicy { feedId: string; channel: string; maxAgeMs: number; maxConfidence: bigint; exponent: number; }
export class OracleTracker {
  private lastTimestamp = 0;
  constructor(private readonly policy: OraclePolicy) {}
  accept(update: OracleUpdate, now: number): void {
    if (update.feedId !== this.policy.feedId || update.channel !== this.policy.channel) throw new Error("unexpected oracle binding");
    if (update.exponent !== this.policy.exponent || update.price <= 0n) throw new Error("invalid oracle price");
    if (update.confidence > this.policy.maxConfidence) throw new Error("oracle confidence too wide");
    if (update.timestamp > now || now - update.timestamp > this.policy.maxAgeMs) throw new Error("stale oracle update");
    if (update.timestamp <= this.lastTimestamp) throw new Error("non-monotonic oracle update");
    if (update.status !== "Open" || update.session === "Closed") throw new Error("market not tradeable");
    this.lastTimestamp = update.timestamp;
  }
  get timestamp() { return this.lastTimestamp; }
}
export function requirePythServerConfig(env: Record<string, string | undefined>): { apiKey: string; feedId: string } {
  if (!env.PYTH_PRO_API_KEY) throw new Error("PYTH_PRO_API_KEY is required for live verification");
  if (!env.PYTH_PRO_AAPL_FEED_ID) throw new Error("PYTH_PRO_AAPL_FEED_ID must be verified from the Pyth Pro catalog");
  return { apiKey: env.PYTH_PRO_API_KEY, feedId: env.PYTH_PRO_AAPL_FEED_ID };
}
