"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, BookOpen, HeartPulse, Percent, Radio, Vault, type LucideIcon } from "lucide-react";
import type { RawMarketEvent } from "@/features/activity/use-market-events";
import { humanizeEventKind, matchesActivityFilter, toActivityRow, type ActivityFilterId } from "@/lib/activity-view-model";
import { relativeTime } from "@/components/ui/primitives";

const CATEGORY: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  book: { icon: BookOpen, label: "Order book", color: "var(--t-link)" },
  fill: { icon: ArrowLeftRight, label: "Trade", color: "var(--t-up)" },
  funding: { icon: Percent, label: "Funding", color: "var(--t-warn)" },
  health: { icon: HeartPulse, label: "Market", color: "var(--t-down)" },
  oracle: { icon: Radio, label: "Oracle", color: "var(--t-text-2)" },
  custody: { icon: Vault, label: "Custody", color: "var(--t-up)" },
};

/** Re-renders every few seconds so "12s ago" stays true. */
function useNow(intervalMs = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** Timeline of market events: icon per category, readable name, when and where. */
export function ActivityFeed({ events, filter = "all", limit = 30, emptyText = "No events yet. They appear here as the market moves." }: {
  events: readonly RawMarketEvent[];
  filter?: ActivityFilterId;
  limit?: number;
  emptyText?: string;
}) {
  const now = useNow();
  const rows = events.map(toActivityRow).filter((row) => matchesActivityFilter(row.category, filter)).slice(0, limit);
  if (rows.length === 0) return <p className="px-1 py-6 text-center text-[12.5px] text-[var(--t-text-2)]">{emptyText}</p>;
  return (
    <ol data-testid="activity-feed" className="divide-y divide-[var(--t-border)]">
      {rows.map((row) => {
        const meta = CATEGORY[row.category] ?? { icon: HeartPulse, label: row.category, color: "var(--t-text-2)" };
        const Icon = meta.icon;
        return (
          <li key={row.id} className="flex items-center gap-3 py-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--t-surface-3)]" style={{ color: meta.color }}>
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-[var(--t-text)]">{humanizeEventKind(row.detail)}</div>
              <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--t-text-3)]">
                <span>{meta.label}</span>
                <span aria-hidden>·</span>
                <time dateTime={new Date(row.observedAt).toISOString()} title={new Date(row.observedAt).toLocaleString()}>{relativeTime(row.observedAt, now)}</time>
                {row.domain ? <span className="rounded bg-[var(--t-surface-3)] px-1 text-[10px] font-semibold uppercase text-[var(--t-text-2)]">{row.domain === "er" ? "Rollup" : "L1"}</span> : null}
              </div>
            </div>
            {row.sequence !== null ? <span className="tnum shrink-0 font-mono text-[11px] text-[var(--t-text-3)]" title="Event sequence">#{row.sequence.toLocaleString()}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
