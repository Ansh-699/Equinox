/**
 * Typed rendering boundary for the Activity feed's raw market events
 * (features/activity/use-market-events.ts). Decodes nothing itself -- the
 * event's fine-grained KIND NAME (`payload.kind`) is already fully decoded
 * and verified upstream (workers/src/event-decoder.ts's EVENT_KIND_NAMES,
 * same discriminator lib/oracle-safety.ts reads). This module's only job
 * is turning that already-typed wire shape into a rendering-ready row,
 * honestly, without ever inventing a value the wire data didn't provide.
 */

export interface RawActivityEvent {
  id: string;
  kind: string;
  sequence?: number;
  domain?: "l1" | "er";
  observedAt: number;
  payload?: { kind?: string };
}

export interface ActivityRowView {
  id: string;
  /** The coarse category (book/fill/funding/health/oracle/custody) --
   * always present, since the stream always carries it. */
  category: string;
  /** The fine-grained decoded event name (e.g. "MarketPaused",
   * "OrderPlaced"), or the literal string below when the wire event
   * didn't carry one -- never fabricated. */
  detail: string;
  sequence: number | null;
  domain: "l1" | "er" | null;
  observedAt: number;
}

export const ACTIVITY_DETAIL_UNAVAILABLE = "details unavailable";

export function toActivityRow(event: RawActivityEvent): ActivityRowView {
  return {
    id: event.id,
    category: event.kind,
    detail: event.payload?.kind ?? ACTIVITY_DETAIL_UNAVAILABLE,
    sequence: event.sequence ?? null,
    domain: event.domain ?? null,
    observedAt: event.observedAt,
  };
}

/** "OrderPartiallyFilled" -> "Order partially filled". Only reshapes the
 * already-decoded name; "details unavailable" and "Unknown(n)" pass through. */
export function humanizeEventKind(detail: string): string {
  if (!/^[A-Z][A-Za-z]+$/.test(detail)) return detail;
  const words = detail.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  return words.map((word, index) => (index === 0 ? word : word.toLowerCase())).join(" ");
}

/** Filter groups the Activity feed offers over the coarse categories. */
export const ACTIVITY_FILTERS = [
  { id: "all", label: "All", categories: null },
  { id: "trades", label: "Trades", categories: ["fill"] },
  { id: "orders", label: "Orders", categories: ["book"] },
  { id: "funding", label: "Funding", categories: ["funding"] },
  { id: "oracle", label: "Oracle", categories: ["oracle"] },
  { id: "custody", label: "Custody", categories: ["custody"] },
  { id: "market", label: "Market", categories: ["health"] },
] as const;
export type ActivityFilterId = (typeof ACTIVITY_FILTERS)[number]["id"];

export function matchesActivityFilter(category: string, filter: ActivityFilterId): boolean {
  const entry = ACTIVITY_FILTERS.find((f) => f.id === filter);
  return !entry?.categories || (entry.categories as readonly string[]).includes(category);
}
