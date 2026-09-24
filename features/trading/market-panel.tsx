"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { V3_MARKETS } from "@/lib/v3-markets";
import { PriceChart } from "./price-chart";
import type { BookLevel } from "./use-v3-book";
import { RESOLUTIONS, useCandles } from "./use-candles";

export interface OracleView { price: number; confidence: number; tradingOpen: boolean }

const DAY = RESOLUTIONS.find((r) => r.code === "60") ?? RESOLUTIONS[3];

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-[var(--t-up)]" : tone === "down" ? "text-[var(--t-down)]" : "text-[var(--t-text)]";
  return (
    <div className="flex shrink-0 flex-col justify-center gap-0.5">
      <span className="text-[10.5px] leading-none text-[var(--t-text-3)]">{label}</span>
      <span className={`tnum text-[13px] font-medium leading-none ${color}`}>{value}</span>
    </div>
  );
}

/** Market picker: every configured market, with the deployed one marked live. */
function MarketPicker({ symbol, onChange }: { symbol: string; onChange: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const current = V3_MARKETS.find((m) => m.symbol === symbol);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Market: ${symbol}. Change market`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-[6px] px-2 transition-colors hover:bg-[var(--t-surface-3)]"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--t-surface-3)] text-[10px] font-bold text-[var(--t-text)]">{symbol.slice(0, 1)}</span>
        <span className="flex flex-col items-start leading-none">
          <span className="text-[16px] font-semibold tracking-tight text-[var(--t-text)]">{symbol}</span>
          <span className="mt-0.5 text-[11px] text-[var(--t-text-3)]">{current?.name ?? ""} {current?.kind === "pre-ipo" ? "pre-IPO perpetual" : "perpetual"}</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-[var(--t-text-2)] transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>
      {open && (
        <ul role="listbox" aria-label="Markets" className="absolute left-0 top-[calc(100%+6px)] z-40 w-[280px] overflow-hidden rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] py-1 shadow-2xl">
          {V3_MARKETS.map((m) => (
            <li key={m.symbol} role="option" aria-selected={m.symbol === symbol}>
              <button
                type="button"
                onClick={() => { onChange(m.symbol); setOpen(false); }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--t-surface-3)]"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--t-surface-3)] text-[11px] font-bold">{m.symbol.slice(0, 1)}</span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[13px] font-semibold text-[var(--t-text)]">{m.symbol}</span>
                  <span className="text-[11px] text-[var(--t-text-3)]">{m.name} · {m.oracle.kind === "pyth" ? "Pyth price" : "PreStocks price"} · up to 5×</span>
                </span>
                {m.kind === "pre-ipo"
                  ? <span className="rounded bg-[var(--t-surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--t-text)]">PRE-IPO</span>
                  : <span className="rounded bg-[var(--t-up-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--t-up)]">LIVE</span>}
                {m.symbol === symbol ? <Check className="h-3.5 w-3.5 text-[var(--t-up)]" /> : <span className="w-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Full-width market header (SlipStream MarketBar): picker, verified price,
 * 24h move, and the execution facts a trader needs before entering. */
export function MarketBar({
  marketSymbol,
  onMarketSymbolChange,
  marketApiUrl,
  live,
  price,
  oracle,
  oracleAgeSeconds,
}: {
  marketSymbol: string;
  onMarketSymbolChange: (symbol: string) => void;
  marketApiUrl: string | undefined;
  live: { price: number; publishTime: number } | null;
  /** Headline index price: the verified snapshot, or the latest Pyth close while it is stale. */
  price: number | null;
  oracle: OracleView | null;
  oracleAgeSeconds: number | null;
}) {
  const { candles } = useCandles(marketApiUrl, marketSymbol, DAY, live);
  const day = useMemo(() => {
    if (candles.length < 2) return null;
    const window = candles.slice(-24);
    const open = window[0].o;
    const last = window[window.length - 1].c;
    return { high: Math.max(...window.map((c) => c.h)), low: Math.min(...window.map((c) => c.l)), change: last - open, changePct: open > 0 ? ((last - open) / open) * 100 : 0 };
  }, [candles]);
  // The cron refreshes every minute; only a missed refresh is worth a warning.
  const stale = oracleAgeSeconds !== null && oracleAgeSeconds > 90;
  const up = day ? day.change >= 0 : null;

  return (
    <section aria-label="Market summary" className="flex h-[56px] shrink-0 items-center gap-5 border-b border-[var(--t-border)] px-3">
      <MarketPicker symbol={marketSymbol} onChange={onMarketSymbolChange} />
      <div className="flex shrink-0 items-baseline gap-2.5">
        <span className={`tnum text-[22px] font-semibold leading-none tracking-tight ${price === null ? "text-[var(--t-text-3)]" : up === null ? "text-[var(--t-text)]" : up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
          {price === null ? "—" : price.toFixed(2)}
        </span>
        {day && up !== null && (
          <span className={`tnum text-[12px] font-medium ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
            {up ? "+" : "−"}${Math.abs(day.change).toFixed(2)} ({up ? "+" : "−"}{Math.abs(day.changePct).toFixed(2)}%)
          </span>
        )}
      </div>
      <div className="h-7 w-px shrink-0 bg-[var(--t-border)]" />
      <div role="group" aria-label="Market stats" tabIndex={0} className="flex min-w-0 items-center gap-6 overflow-x-auto [scrollbar-width:none]">
        <Stat label="24h High" value={day ? day.high.toFixed(2) : "—"} />
        <Stat label="24h Low" value={day ? day.low.toFixed(2) : "—"} />
        <Stat label="Session" value={oracle ? (oracle.tradingOpen ? "Open" : "Closed") : "—"} tone={oracle ? (oracle.tradingOpen ? "up" : "down") : undefined} />
      </div>
      {stale ? (
        <div role="status" className="ml-auto shrink-0 rounded border border-[var(--t-warn)]/40 bg-[var(--t-warn)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--t-warn)]">
          On-chain price is {oracleAgeSeconds > 3600 ? `${Math.floor(oracleAgeSeconds / 3600)}h` : oracleAgeSeconds > 60 ? `${Math.floor(oracleAgeSeconds / 60)}m` : `${oracleAgeSeconds}s`} old — refreshed when you trade
        </div>
      ) : null}
    </section>
  );
}

/** Chart column head; the sr-only h1 names the page for assistive tech. */
export function MarketPanel({ marketSymbol, marketApiUrl, live, depth }: { marketSymbol: string; marketApiUrl: string | undefined; live: { price: number; publishTime: number } | null; depth: { bids: BookLevel[]; asks: BookLevel[] } }) {
  return (
    <section className="market-panel h-full">
      <h1 className="sr-only">{marketSymbol}</h1>
      <PriceChart marketApiUrl={marketApiUrl} symbol={marketSymbol} live={live} depth={depth} />
    </section>
  );
}
