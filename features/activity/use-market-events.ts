"use client";

import { useEffect, useState } from "react";

export interface RawMarketEvent {
  id: string;
  kind: string;
  sequence?: number;
  domain?: "l1" | "er";
  observedAt: number;
}

const MAX_EVENTS = 100;

/** Raw, undecoded-beyond-kind market events for the Activity feed. Kinds
 * are "book" | "fill" | "funding" | "health" | "oracle" | "custody"
 * (workers/src/types.ts) -- there is no finer-grained "order placed" vs
 * "order cancelled" vs "order replaced" distinction available without the
 * canonical event ABI manifest (blocked), so this deliberately does not
 * pretend to categorize further than the backend already does. */
export function useMarketEvents(marketApiUrl: string | undefined, symbol: string) {
  const [events, setEvents] = useState<RawMarketEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "unavailable">(marketApiUrl ? "connecting" : "unavailable");

  useEffect(() => {
    if (!marketApiUrl) return;
    let stopped = false;
    const append = (incoming: RawMarketEvent[]) => {
      if (!incoming.length) return;
      setEvents((current) => [...incoming, ...current].slice(0, MAX_EVENTS));
      setStatus("live");
    };

    void fetch(`${marketApiUrl}/v1/markets/${symbol}/snapshot`)
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("snapshot unavailable"))))
      .then((data: { events: RawMarketEvent[] }) => { if (!stopped) append([...data.events].reverse()); })
      .catch(() => { if (!stopped) setStatus("unavailable"); });

    const socketUrl = new URL(`${marketApiUrl}/v1/markets/${symbol}/stream`);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as RawMarketEvent | { events: RawMarketEvent[] };
      append("events" in data ? [...data.events].reverse() : [data]);
    };
    socket.onerror = () => { if (!stopped) setStatus("unavailable"); };
    return () => { stopped = true; socket.close(); };
  }, [marketApiUrl, symbol]);

  return { events, status };
}
