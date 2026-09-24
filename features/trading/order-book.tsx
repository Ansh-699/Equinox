"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { V3Book } from "./use-v3-book";
import { Spinner } from "@/components/ui/spinner";

const DEPTH = 20;

/** Placeholder ladder while the first read of the book is in flight. */
function BookSkeleton() {
  const rows = (side: "ask" | "bid") => Array.from({ length: 10 }, (_, i) => (
    <div key={`${side}${i}`} className="grid h-5 grid-cols-3 items-center gap-3 px-3">
      <span className={`h-2.5 w-14 animate-pulse rounded ${side === "ask" ? "bg-[var(--t-down)]/20" : "bg-[var(--t-up)]/20"}`} />
      <span className="ml-auto h-2.5 w-8 animate-pulse rounded bg-[var(--t-surface-3)]" />
      <span className="ml-auto h-2.5 w-10 animate-pulse rounded bg-[var(--t-surface-3)]" />
    </div>
  ));
  return (
    <div role="status" aria-label="Loading the order book" className="flex flex-1 flex-col justify-center gap-0.5 py-2">
      {rows("ask")}
      <div className="flex h-8 items-center gap-2 px-3 text-[11px] text-[var(--t-text-2)]"><Spinner /> Loading the live book from the rollup…</div>
      {rows("bid")}
    </div>
  );
}

/** Order book (SlipStream ladder) over the live V3 book pages: Book/Trades
 * tabs, cumulative depth bars, mid/spread and buy/sell pressure. */
const CLOSED_HINT = "TSLA trades in the US session (pre-market 4:00 ET through after-hours 20:00 ET). The program refuses orders while Pyth reports the market closed; quotes return when it reopens.";

export function OrderBookDisplay({ book, symbol, onPickPrice, marketClosed = false }: { book: V3Book; symbol: string; onPickPrice?: (price: number) => void; marketClosed?: boolean }) {
  const { bids, asks, trades, status, updatedAt, domain } = book;
  const [tab, setTab] = useState<"book" | "trades">("book");

  const { askRows, bidRows, maxCum, mid, spread, buyPct } = useMemo(() => {
    const cumulate = (levels: { price: number; size: number }[]) => {
      let total = 0;
      const rows = levels.slice(0, DEPTH).map((l) => ({ ...l, total: (total += l.size) }));
      return { rows, total };
    };
    const { rows: askRows, total: askTotal } = cumulate(asks);
    const { rows: bidRows, total: bidTotal } = cumulate(bids);
    const mid = bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : bids[0]?.price ?? asks[0]?.price ?? null;
    const spread = bids.length && asks.length ? asks[0].price - bids[0].price : null;
    const buyPct = bidTotal + askTotal > 0 ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;
    return { askRows, bidRows, maxCum: Math.max(askTotal, bidTotal, 0.0001), mid, spread, buyPct };
  }, [bids, asks]);
  const empty = bids.length === 0 && asks.length === 0;
  const sellPct = 100 - buyPct;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--t-bg)]">
      <div className="tk-head justify-between">
        <div role="tablist" aria-label="Order book" className="flex items-stretch gap-4">
          <button type="button" role="tab" aria-selected={tab === "book"} aria-controls="book-panel" className="tk-tab" onClick={() => setTab("book")}>Book</button>
          <button type="button" role="tab" aria-selected={tab === "trades"} aria-controls="trades-panel" className="tk-tab" onClick={() => setTab("trades")}>Trades</button>
        </div>
        <span className="text-[11px] text-[var(--t-text-3)]">{symbol}</span>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--t-border)] px-3">
        <span className="tk-chip">{domain === "er" ? "MagicBlock ER" : "Solana L1"}</span>
        <span className="tk-chip">Price-time priority</span>
      </div>

      {status === "stale" && updatedAt !== null && (
        <div role="status" className="shrink-0 border-b border-[var(--t-warn)]/30 bg-[var(--t-warn)]/10 px-3 py-1 text-[11px] font-medium text-[var(--t-warn)]">
          Not updating — last read at {new Date(updatedAt).toLocaleTimeString()}
        </div>
      )}

      {tab === "book" ? (
        <div id="book-panel" role="tabpanel" aria-label="Order book" className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 grid-cols-3 px-3 py-1.5 text-[11px] text-[var(--t-text-3)]">
            <span>Price (USD)</span>
            <span className="text-right">Size (shares)</span>
            <span className="text-right">Total</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {empty && status === "loading" ? (
              <BookSkeleton />
            ) : empty ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
                <span className="text-[12px] text-[var(--t-text)]">
                  {status === "loading" ? "Loading the book…" : status === "unavailable" ? "Can't reach the order book" : status === "stale" ? "Book not updating" : marketClosed ? "Market closed" : "No resting orders"}
                </span>
                <span className="max-w-[34ch] text-[11px] leading-relaxed text-[var(--t-text-2)]">
                  {marketClosed && status !== "unavailable"
                    ? CLOSED_HINT
                    : status === "unavailable"
                    ? "Neither the rollup nor the base layer answered."
                    : status === "empty"
                      ? domain === "er" ? "The book decoded cleanly but nobody is quoting." : "Orders match in the MagicBlock rollup; the book fills once the market is delegated."
                      : ""}
                </span>
              </div>
            ) : (
              <>
                <div className="slim-scroll flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
                  {askRows.map((l, slot) => <Row key={`a-${slot}`} {...l} pct={Math.min(100, (l.total / maxCum) * 100)} side="ask" onPick={onPickPrice} />)}
                </div>
                <MidRow mid={mid} spread={spread} />
                <div className="slim-scroll flex min-h-0 flex-1 flex-col justify-start overflow-y-auto">
                  {bidRows.map((l, slot) => <Row key={`b-${slot}`} {...l} pct={Math.min(100, (l.total / maxCum) * 100)} side="bid" onPick={onPickPrice} />)}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div id="trades-panel" role="tabpanel" aria-label="Recent trades" className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 grid-cols-3 px-3 py-1.5 text-[11px] text-[var(--t-text-3)]">
            <span>Price (USD)</span>
            <span className="text-right">Size (shares)</span>
            <span className="text-right">Time</span>
          </div>
          <div className="slim-scroll min-h-0 flex-1 overflow-y-auto">
            {trades.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--t-text-2)]">
                {status === "loading" ? <><Spinner /> Loading trades…</> : status === "unavailable" ? "Can't reach the order book" : "No trades yet"}
              </div>
            ) : (
              trades.map((t, i) => {
                const up = i + 1 < trades.length ? t.price >= trades[i + 1].price : true;
                return (
                  <div key={t.sequence} className="grid h-5 grid-cols-3 items-center px-3 text-[11.5px] hover:bg-[var(--t-surface-3)]">
                    <span className={`tnum ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{t.price.toFixed(2)}</span>
                    <span className="tnum text-right text-[var(--t-text)]">{t.size.toLocaleString()}</span>
                    <span className="tnum text-right text-[var(--t-text-2)]">{t.time ? new Date(t.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {!empty && (
        <div role="img" aria-label={`Resting depth: ${buyPct.toFixed(0)}% bids, ${sellPct.toFixed(0)}% asks`} className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--t-border)] px-3">
          <span className="tnum shrink-0 text-[11px] text-[var(--t-up)]">Buy {buyPct.toFixed(0)}%</span>
          <div aria-hidden className="flex h-1 flex-1 overflow-hidden rounded-[4px] bg-[var(--t-surface)]">
            <div className="h-full bg-[var(--t-up)]" style={{ width: `${buyPct}%` }} />
            <div className="h-full flex-1 bg-[var(--t-down)]" />
          </div>
          <span className="tnum shrink-0 text-[11px] text-[var(--t-down)]">{sellPct.toFixed(0)}% Sell</span>
        </div>
      )}
    </div>
  );
}

const BOOK_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function tintNumber(element: HTMLElement | null, direction: "up" | "down", duration = 180) {
  if (!element || typeof element.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  element.getAnimations().forEach((animation) => animation.cancel());
  element.animate(
    [{ color: direction === "up" ? "var(--t-up)" : "var(--t-down)" }, { color: getComputedStyle(element).color }],
    { duration, easing: BOOK_EASE }
  );
}

function useNumericTint(value: number, display: string) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef({ value, display });
  useEffect(() => {
    const before = previous.current;
    previous.current = { value, display };
    if (display !== before.display) tintNumber(element.current, value > before.value ? "up" : "down");
  }, [value, display]);
  return element;
}

function MidRow({ mid, spread }: { mid: number | null; spread: number | null }) {
  const [shown, setShown] = useState<"up" | "down" | null>(null);
  const prevMid = useRef<number | null>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const p = prevMid.current;
    prevMid.current = mid;
    if (p === null || mid === null || mid === p) return;
    const direction = mid > p ? "up" : "down";
    setShown(direction);
    tintNumber(priceRef.current, direction, 200);
    const timer = window.setTimeout(() => setShown(null), 200);
    return () => window.clearTimeout(timer);
  }, [mid]);

  return (
    <div className="relative h-[34px] shrink-0 flex items-baseline gap-2 px-3 border-y border-[var(--t-border)]">
      <span ref={priceRef} className="relative text-[15px] font-bold tnum text-[var(--t-text)] leading-[34px]">
        {mid !== null ? mid.toFixed(2) : "—"}
      </span>
      <span aria-hidden className={`inline-flex w-3 shrink-0 self-center ${shown === "up" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"} ${shown && mid !== null ? "opacity-100" : "opacity-0"}`}>
        {shown === "down" ? <ArrowDown size={12} strokeWidth={2} /> : <ArrowUp size={12} strokeWidth={2} />}
      </span>
      <span className="text-[11px] text-[var(--t-text-3)]">mid</span>
      <span className="ml-auto text-[11px] text-[var(--t-text-2)] tnum">
        {spread !== null ? `spread ${spread.toFixed(2)}` : ""}
      </span>
    </div>
  );
}

const Row = memo(function Row({
  price,
  size,
  total,
  pct,
  side,
  onPick,
}: {
  price: number;
  size: number;
  total: number;
  pct: number;
  side: "bid" | "ask";
  onPick?: (price: number) => void;
}) {
  const priceText = price.toFixed(2);
  const sizeText = fmtAmt(size);
  const totalText = fmtAmt(total);
  const priceRef = useNumericTint(price, priceText);
  const sizeRef = useNumericTint(size, sizeText);
  const totalRef = useNumericTint(total, totalText);
  const previousTotal = useRef(total);
  const depthRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const depthChanged = previousTotal.current !== total;
    previousTotal.current = total;
    if (!depthChanged || !depthRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    depthRef.current.getAnimations().forEach((animation) => animation.cancel());
    depthRef.current.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 160, easing: BOOK_EASE });
  }, [total]);
  return (
    <div
      className={`relative grid h-5 shrink-0 grid-cols-3 items-center px-3 text-[11.5px] ${onPick ? "cursor-pointer hover:bg-[var(--t-surface-3)]" : ""}`}
      onClick={onPick ? () => onPick(price) : undefined}
      title={onPick ? "Use this price" : undefined}
    >
      <div
        ref={depthRef}
        aria-hidden
        className="absolute inset-y-0 right-0 motion-safe:transition-[width] motion-safe:duration-[160ms] motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{
          width: `${pct}%`,
          backgroundColor: side === "bid" ? "rgba(58,191,114,0.12)" : "rgba(224,85,85,0.12)",
        }}
      />
      <span ref={priceRef} className={`relative tnum ${side === "bid" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
        {priceText}
      </span>
      <span ref={sizeRef} className="relative text-right tnum text-[var(--t-text)]">{sizeText}</span>
      <span ref={totalRef} className="relative text-right tnum text-[var(--t-text-2)]">{totalText}</span>
    </div>
  );
});

function fmtAmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
