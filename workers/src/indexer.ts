import type { IndexedCursor, MarketEvent, MarketSnapshot } from "./types";

export type IndexDomain = "l1" | "er";

export function nextCursor(cursor: IndexedCursor, event: MarketEvent): IndexedCursor | null {
  if (event.domain && event.domain !== cursor.domain) return null;
  if (event.sequence === undefined) return null;
  if (event.sequence <= cursor.sequence) return cursor;
  if (event.sequence !== cursor.sequence + 1) return null;
  return { ...cursor, sequence: event.sequence, slot: event.slot ?? cursor.slot };
}

export function applyEvent(snapshot: MarketSnapshot, event: MarketEvent): MarketSnapshot {
  const sequence = event.sequence ?? snapshot.sequence + 1;
  return {
    ...snapshot,
    sequence,
    domain: event.domain ?? snapshot.domain,
    events: [...snapshot.events.filter((item) => item.id !== event.id), event].slice(-256),
    capturedAt: event.observedAt,
  };
}

export function reconcileBatch(snapshot: MarketSnapshot, events: readonly MarketEvent[]) {
  let current = snapshot;
  for (const event of events) {
    const cursor: IndexedCursor = { market: snapshot.market.marketPda, domain: current.domain, sequence: current.sequence, slot: 0 };
    const next = nextCursor(cursor, event);
    if (!next) return { kind: "gap" as const, snapshot: current, event };
    current = applyEvent(current, event);
  }
  return { kind: "applied" as const, snapshot: current };
}
