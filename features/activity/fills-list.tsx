"use client";

import { MarketIcon } from "@/components/ui/market-icon";
import { marketPair } from "@/lib/v3-markets";
import type { Fill } from "./use-recent-fills";

const TIME = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fills as rows: time, market, size @ price, notional, and "You" when one of
 * `mySeats` (market symbol → seat index) was the maker or the taker. */
export function FillsList({ fills, mySeats = {}, limit = 30, empty = "Waiting for fills…" }: { fills: readonly Fill[]; mySeats?: Record<string, number>; limit?: number; empty?: string }) {
  const rows = fills.slice(0, limit);
  if (rows.length === 0) return <p className="py-8 text-center text-[12.5px] text-[var(--t-text-3)]">{empty}</p>;
  return (
    <ol className="divide-y divide-[var(--t-border)]">
      {rows.map((fill) => {
        const mine = mySeats[fill.market];
        const role = mine === undefined ? null : fill.takerSeat === mine ? "taker" : fill.makerSeat === mine ? "maker" : null;
        return (
          <li key={`${fill.market}:${fill.sequence}`} className="tnum grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-2.5 text-[12.5px] sm:grid-cols-[64px_minmax(0,1fr)_auto_auto] sm:gap-3">
            <span className="order-2 text-right text-[var(--t-text-3)] sm:order-none sm:text-left">{fill.time ? TIME.format(fill.time * 1000) : "—"}</span>
            <span className="order-1 flex min-w-0 items-center gap-2 sm:order-none">
              <MarketIcon symbol={fill.market} size={20} />
              <span className="truncate font-medium text-[var(--t-text)]" style={{ fontFamily: "var(--font-ui)" }}>{marketPair(fill.market)}</span>
              {role ? <span className="shrink-0 rounded-[4px] bg-[var(--t-accent)]/15 px-1.5 py-px text-[10.5px] font-medium text-[var(--t-accent)]" style={{ fontFamily: "var(--font-ui)" }}>You · {role}</span> : null}
            </span>
            <span className="order-3 text-[var(--t-text-2)] sm:order-none">{fill.size} @ {USD.format(fill.price)}</span>
            <span className="order-4 text-right text-[var(--t-text)] sm:order-none sm:w-[92px]">${USD.format(fill.size * fill.price)}</span>
          </li>
        );
      })}
    </ol>
  );
}
