"use client";

import { useEffect, useRef, useState } from "react";
import { advanceSequence, seedFromSnapshot, INITIAL_SEQUENCE_TRACKER, type SequenceTrackerState } from "@/lib/sequence-recovery";

export interface RawMarketEvent {
  id: string;
  kind: string;
  sequence?: number;
  domain?: "l1" | "er";
  slot?: number;
  observedAt: number;
  /** Only the fully-decoded, verified event KIND NAME (the discriminator,
   * per workers/src/event-decoder.ts's EVENT_KIND_NAMES) is typed here --
   * see lib/oracle-safety.ts. The category-specific 48-byte payload body
   * this wraps (`payload.payload` on the wire) stays untouched: there is
   * no verified layout for it. */
  payload?: { kind?: string };
}

const MAX_EVENTS = 100;
const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface MarketEventStreamHealth {
  events: RawMarketEvent[];
  status: "connecting" | "live" | "resynchronizing" | "unavailable";
  /** Honest diagnostics, never hidden from the UI: a gap or duplicate is a
   * real thing that happened on this connection, not an internal detail. */
  gapCount: number;
  duplicateCount: number;
  lastGapAt: number | null;
}

/** Raw, undecoded-beyond-kind market events for the Activity feed. Kinds
 * are "book" | "fill" | "funding" | "health" | "oracle" | "custody"
 * (workers/src/types.ts) -- there is no finer-grained "order placed" vs
 * "order cancelled" vs "order replaced" distinction available without the
 * canonical event ABI manifest (blocked), so this deliberately does not
 * pretend to categorize further than the backend already does.
 *
 * Sequence-gap recovery (lib/sequence-recovery.ts) mirrors the indexer's
 * own per-domain gap detection: an event carrying a lower/equal sequence
 * than one already seen for its domain is a duplicate and is dropped; a
 * sequence that skips ahead is a gap, and a slot that goes backwards on a
 * higher sequence is treated the same way -- both force a fresh snapshot
 * fetch rather than silently trusting an incomplete or corrupted stream.
 * A dropped WebSocket connection gets the identical treatment: reconnect,
 * then always re-fetch a snapshot before trusting the new socket's events,
 * since events lost during the outage would otherwise never surface as a
 * detectable gap (the very next message could coincidentally look
 * in-order against the stale pre-disconnect cursor). */
export function useMarketEvents(marketApiUrl: string | undefined, symbol: string): MarketEventStreamHealth {
  const [events, setEvents] = useState<RawMarketEvent[]>([]);
  const [status, setStatus] = useState<MarketEventStreamHealth["status"]>(marketApiUrl ? "connecting" : "unavailable");
  const [gapCount, setGapCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [lastGapAt, setLastGapAt] = useState<number | null>(null);
  const trackerRef = useRef<SequenceTrackerState>(INITIAL_SEQUENCE_TRACKER);

  useEffect(() => {
    if (!marketApiUrl) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const loadSnapshot = async (): Promise<boolean> => {
      try {
        const response = await fetch(`${marketApiUrl}/v1/markets/${symbol}/snapshot`);
        if (!response.ok) throw new Error("snapshot unavailable");
        const data = (await response.json()) as { events: RawMarketEvent[] };
        if (stopped) return false;
        trackerRef.current = seedFromSnapshot(trackerRef.current, data.events.filter(hasSequenceAndDomain));
        setEvents([...data.events].reverse().slice(0, MAX_EVENTS));
        return true;
      } catch {
        if (!stopped) setStatus("unavailable");
        return false;
      }
    };

    const ingest = (incoming: RawMarketEvent[]) => {
      if (!incoming.length) return;
      const accepted: RawMarketEvent[] = [];
      for (const event of incoming) {
        if (!hasSequenceAndDomain(event)) { accepted.push(event); continue; } // untracked kind -- append as-is
        const result = advanceSequence(trackerRef.current, event);
        trackerRef.current = result.state;
        if (result.outcome === "duplicate") { setDuplicateCount((count) => count + 1); continue; }
        if (result.outcome === "gap" || result.outcome === "slot_regression") {
          setGapCount((count) => count + 1);
          setLastGapAt(Date.now());
          setStatus("resynchronizing");
          accepted.push(event); // still real data -- append it, then repair the hole behind it
          void loadSnapshot().then((ok) => { if (ok && !stopped) setStatus("live"); });
          continue;
        }
        accepted.push(event);
      }
      if (accepted.length) setEvents((current) => [...accepted, ...current].slice(0, MAX_EVENTS));
      // Functional update, not a read of the outer `status` closure: this
      // effect intentionally never re-runs on status changes (see the
      // exhaustive-deps suppression below), so a plain `status` read here
      // would be permanently stale from the moment the effect first ran.
      setStatus((current) => (current === "resynchronizing" ? current : "live"));
    };

    const connect = () => {
      if (stopped) return;
      const socketUrl = new URL(`${marketApiUrl}/v1/markets/${symbol}/stream`);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(socketUrl);
      socket.onopen = () => { consecutiveFailures = 0; }; // a real connection proves the endpoint is reachable again
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data) as RawMarketEvent | { events: RawMarketEvent[] };
        ingest("events" in data ? [...data.events].reverse() : [data]);
      };
      socket.onclose = () => {
        if (stopped) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_RECONNECT_ATTEMPTS) {
          // Genuinely gone, not a blip -- say so honestly rather than
          // retrying forever with the UI stuck showing "resynchronizing".
          setStatus("unavailable");
          return;
        }
        setStatus("resynchronizing");
        reconnectTimer = setTimeout(() => {
          void loadSnapshot().then(() => { if (!stopped) connect(); });
        }, RECONNECT_DELAY_MS);
      };
      socket.onerror = () => socket?.close();
    };

    void loadSnapshot().then((ok) => { if (ok && !stopped) connect(); });

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [marketApiUrl, symbol]);

  return { events, status, gapCount, duplicateCount, lastGapAt };
}

function hasSequenceAndDomain(event: RawMarketEvent): event is RawMarketEvent & { sequence: number; domain: "l1" | "er" } {
  return typeof event.sequence === "number" && (event.domain === "l1" || event.domain === "er");
}
