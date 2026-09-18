/**
 * Oracle safety UI state machine, built ONLY from already-verified typed
 * fields: `MarketStateView.oracleValid`/`lastVerifiedOracleTimestamp`
 * (byte-offset-verified account header fields, clients/stockstream/src/
 * index.ts::decodeMarketState) and market-event KIND NAMES (the 2-byte
 * discriminator decoded and verified against events.rs by
 * workers/src/event-decoder.ts's EVENT_KIND_NAMES table).
 *
 * The event's KIND is fully decoded data, not a guess -- it's the same
 * discriminator the header already commits to. What stays untouched is
 * the event's 48-byte category-specific PAYLOAD BODY (event.payload.payload
 * in the wire shape), which is exactly the "raw oracle payload" this
 * module is required to never decode: there is no verified byte layout
 * for it, so no price/staleness detail is ever read out of it here.
 */

export type OracleSafetyState = "fresh" | "stale" | "closed" | "halted" | "corp_action" | "unknown";

/** The only market-event kinds this module looks at -- every one is a
 * fully-decoded, verified discriminator name (events.rs / EVENT_KIND_NAMES),
 * never a raw payload read. */
export const ORACLE_LIFECYCLE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "OracleUpdated", "OracleStale", "OracleRejected", "OracleRecovered",
  "MarketPaused", "MarketResumed", "MarketCloseOnly", "MarketClosed",
  "CorporateActionEntered", "CorporateActionResolved",
]);

// A hard override wins regardless of oracle freshness: a halted or
// corporate-actioned market isn't made safe again just because its oracle
// price happens to still be updating, and a market explicitly flagged
// OracleStale/OracleRejected on-chain shouldn't be shown as fresh just
// because it's within the staleness window by wall-clock alone.
const HARD_OVERRIDE: Partial<Record<string, OracleSafetyState>> = {
  OracleStale: "stale",
  OracleRejected: "stale",
  MarketPaused: "halted",
  MarketCloseOnly: "closed",
  MarketClosed: "closed",
  CorporateActionEntered: "corp_action",
};

const DEFAULT_STALENESS_THRESHOLD_SECONDS = 120;

export interface OracleSafetyInput {
  /** null when the market account itself hasn't been read yet -- this is
   * NOT the same as `false` (a real on-chain flag saying the oracle is
   * invalid): null means "we don't know", false means "we know, and it's
   * not valid". */
  oracleValid: boolean | null;
  lastVerifiedOracleTimestamp: bigint | null;
  /** Wall-clock seconds, for display purposes only -- same caveat as
   * lib/browser-session.ts::isSessionUsable: the program's own notion of
   * "now" is the market's oracle-anchored clock, not this. */
  nowUnixSeconds: number;
  /** The kind name of the most recent event in ORACLE_LIFECYCLE_EVENT_KINDS
   * this client has observed for the market, or null if none yet. */
  latestLifecycleEventKind: string | null;
  stalenessThresholdSeconds?: number;
}

export function deriveOracleSafety(input: OracleSafetyInput): OracleSafetyState {
  if (input.oracleValid === null) return "unknown"; // no account read at all -- never guess a state
  const override = input.latestLifecycleEventKind ? HARD_OVERRIDE[input.latestLifecycleEventKind] : undefined;
  if (override) return override;
  if (!input.oracleValid) return "stale"; // explicitly flagged invalid on-chain, not merely "unknown"
  if (input.lastVerifiedOracleTimestamp === null) return "unknown";
  const threshold = input.stalenessThresholdSeconds ?? DEFAULT_STALENESS_THRESHOLD_SECONDS;
  const ageSeconds = input.nowUnixSeconds - Number(input.lastVerifiedOracleTimestamp);
  return ageSeconds <= threshold ? "fresh" : "stale";
}

/** Picks the most recent (highest-sequence) lifecycle-relevant event kind
 * out of a raw event list -- events without both a kind in
 * ORACLE_LIFECYCLE_EVENT_KINDS and a numeric sequence are ignored rather
 * than guessed at for ordering. */
export function latestLifecycleEventKind(events: readonly { sequence?: number; payload?: { kind?: string } }[]): string | null {
  let best: { sequence: number; kind: string } | null = null;
  for (const event of events) {
    const kind = event.payload?.kind;
    if (!kind || !ORACLE_LIFECYCLE_EVENT_KINDS.has(kind) || typeof event.sequence !== "number") continue;
    if (!best || event.sequence > best.sequence) best = { sequence: event.sequence, kind };
  }
  return best?.kind ?? null;
}
