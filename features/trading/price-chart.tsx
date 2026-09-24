"use client";

import { isReporterPriced, v3MarketFor } from "@/lib/v3-markets";
import { useEffect, useMemo, useRef, useState } from "react";
import { RESOLUTIONS, useCandles, type Candle, type Resolution } from "./use-candles";

type ChartType = "candles" | "line" | "area";

/** Price chart: Pyth Pro OHLC history plus the live verified oracle price.
 * Canvas rendering ported from SlipStream's terminal chart. */
export function PriceChart({ marketApiUrl, symbol, live }: { marketApiUrl: string | undefined; symbol: string; live: { price: number; publishTime: number } | null }) {
  const [resolutionIndex, setResolutionIndex] = useState(1);
  const resolution = RESOLUTIONS[resolutionIndex];
  const [chartType, setChartType] = useState<ChartType>("candles");
  const { candles, error, loading } = useCandles(marketApiUrl, symbol, resolution, live);
  const latest = candles.at(-1) ?? null;
  const change = candles.length >= 2 && candles[0].o > 0 ? ((candles.at(-1)!.c - candles[0].o) / candles[0].o) * 100 : null;

  const up = change !== null && change >= 0;

  return (
    <div className="flex h-full min-h-[360px] w-full flex-col overflow-hidden bg-[var(--t-bg)]">
      <div className="tk-head justify-between gap-3">
        <div role="tablist" aria-label="Chart view" className="flex items-stretch gap-4">
          <button type="button" role="tab" aria-selected aria-controls="chart-panel" className="tk-tab">Chart</button>
          <button type="button" role="tab" aria-selected={false} disabled title="The depth ladder is in the Book panel." className="tk-tab">Depth</button>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="tnum text-[13px] font-medium text-[var(--t-text)]">{latest ? `$${latest.c.toFixed(2)}` : "—"}</span>
          {change !== null && latest && (
            <span className={`tnum text-[11px] font-semibold ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{up ? "+" : "−"}{Math.abs(change).toFixed(2)}%</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--t-border)] px-3 py-1.5 sm:h-9 sm:flex-nowrap sm:py-0">
        <div role="group" aria-label="Candle interval" className="flex items-center gap-1">
          {RESOLUTIONS.map((r, i) => (
            <button key={r.label} type="button" aria-pressed={resolutionIndex === i} aria-label={`${r.label} candles`} onClick={() => setResolutionIndex(i)} className={`${CHIP} ${resolutionIndex === i ? CHIP_ON : CHIP_OFF}`}>{r.label}</button>
          ))}
        </div>
        <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--t-border)]" />
        <div role="group" aria-label="Chart type" className="flex items-center gap-1">
          {(["candles", "line", "area"] as const).map((type) => (
            <button key={type} type="button" aria-pressed={chartType === type} onClick={() => setChartType(type)} className={`${CHIP} capitalize ${chartType === type ? CHIP_ON : CHIP_OFF}`}>{type}</button>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[6px] text-[11px]">
        <span className="text-[var(--t-text-2)]"><span className="font-semibold text-[var(--t-text)]">{symbol}</span> · {resolution.label} · {symbol.replace("-PERP", "")}/USD via {priceSource(symbol)}</span>
        <span className="flex items-center gap-2 text-[var(--t-text-3)]">
          {(["o", "h", "l", "c"] as const).map((key) => (
            <span key={key}>{key.toUpperCase()} <span className="tnum text-[var(--t-text)]">{latest ? latest[key].toFixed(2) : "—"}</span></span>
          ))}
        </span>
      </div>

      <div id="chart-panel" role="tabpanel" aria-label={`${symbol} ${resolution.label} price chart`} className="relative min-h-0 flex-1 bg-[var(--t-bg)]">
        {candles.length >= 2 ? (
          <CandleCanvas candles={candles} chartType={chartType} resolution={resolution} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
            <span className="text-[12px] font-medium text-[var(--t-text)]">{loading ? "Loading price history…" : error ? "Couldn't load price history" : "No candles for this interval"}</span>
            <span className="max-w-[42ch] text-[12px] leading-relaxed text-[var(--t-text-2)]">{error ? "The price-history feed didn't answer. It retries on its own; pick another interval if it stays empty." : `Equity.US.${symbol.replace("-PERP", "")}/USD · Pyth Pro`}</span>
          </div>
        )}
      </div>

      <div className="flex h-[30px] shrink-0 items-center justify-between gap-3 border-t border-[var(--t-border)] px-3 text-[11px] text-[var(--t-text-3)]">
        <span className="hidden xl:inline">Scroll to zoom · drag to pan</span>
        <span className="xl:hidden">Ctrl-scroll to zoom · drag to pan</span>
        <span>{resolution.label} candles · {isReporterPriced(v3MarketFor(symbol)) ? "reporter price history" : "Pyth history"} + verified live price</span>
      </div>
    </div>
  );
}

const CHIP = "h-[26px] min-w-[34px] rounded-[4px] px-2 text-[11px] font-semibold transition-colors";
const CHIP_ON = "bg-[var(--t-surface-3)] text-[var(--t-text)]";
const CHIP_OFF = "text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]";

function CandleCanvas({ candles, chartType, resolution }: { candles: Candle[]; chartType: ChartType; resolution: Resolution }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ count: 80, offset: 0 });
  const [hover, setHover] = useState<{ y: number; i: number } | null>(null);
  const drag = useRef<{ x: number; startOffset: number } | null>(null);
  const dims = useRef({ w: 0, h: 0, dpr: 1 });
  // Repaint on theme flips and container resizes; both change what the canvas must draw.
  const [paint, setPaint] = useState(0);
  useEffect(() => {
    const bump = () => setPaint((n) => n + 1);
    window.addEventListener("themechange", bump);
    const observer = new ResizeObserver(bump);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => { window.removeEventListener("themechange", bump); observer.disconnect(); };
  }, []);

  const total = candles.length;
  const count = Math.min(Math.max(view.count, 15), total);
  const offset = Math.min(Math.max(view.offset, 0), Math.max(0, total - count));
  const end = total - offset;
  const visible = useMemo(() => candles.slice(Math.max(0, end - count), end), [candles, end, count]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || visible.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    // Resizing reallocates the backing store, so only do it when size changes.
    if (dims.current.w !== w || dims.current.h !== h || dims.current.dpr !== dpr) {
      dims.current = { w, h, dpr };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    ctx.clearRect(0, 0, w, h);
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.classList.contains("dark");
    const ink = (alpha: number) => (dark ? `rgba(255,255,255,${alpha})` : `rgba(15,23,23,${alpha})`);
    const up = token("--t-up", "#22c55e");
    const down = token("--t-down", "#ef4444");
    const axis = token("--t-text-3", "#838c92");
    const ground = token("--t-bg", "#0b0d0e");
    const padR = 64, padB = 22, padT = 8;
    const plotW = w - padR, plotH = h - padB - padT;
    let min = Infinity, max = -Infinity;
    for (const c of visible) { min = Math.min(min, c.l); max = Math.max(max, c.h); }
    const pad = (max - min || 1) * 0.08;
    min -= pad; max += pad;
    const yOf = (p: number) => padT + (1 - (p - min) / (max - min)) * plotH;
    const n = visible.length;
    const slot = plotW / n;
    const xOf = (i: number) => i * slot + slot / 2;

    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= 5; g += 1) {
      const price = min + ((max - min) * g) / 5;
      const y = yOf(price);
      ctx.strokeStyle = ink(0.05);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      ctx.fillStyle = axis; ctx.textAlign = "left";
      ctx.fillText(`$${price.toFixed(2)}`, plotW + 6, y);
    }
    ctx.fillStyle = axis; ctx.textAlign = "center";
    const every = Math.ceil(n / 6);
    for (let i = 0; i < n; i += every) {
      const d = new Date(visible[i].t * 1000);
      ctx.fillText(resolution.seconds >= 86400 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, xOf(i), h - padB / 2);
    }

    if (chartType === "candles") {
      const bodyW = Math.max(slot * 0.62, 1);
      for (let i = 0; i < n; i += 1) {
        const c = visible[i];
        const color = c.c >= c.o ? up : down;
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(xOf(i), yOf(c.h)); ctx.lineTo(xOf(i), yOf(c.l)); ctx.stroke();
        const top = Math.min(yOf(c.o), yOf(c.c));
        ctx.fillRect(xOf(i) - bodyW / 2, top, bodyW, Math.max(Math.abs(yOf(c.c) - yOf(c.o)), 1));
      }
    } else {
      const rising = visible[n - 1].c >= visible[0].c;
      const color = rising ? up : down;
      const path = () => { ctx.beginPath(); visible.forEach((c, i) => (i === 0 ? ctx.moveTo(xOf(i), yOf(c.c)) : ctx.lineTo(xOf(i), yOf(c.c)))); };
      if (chartType === "area") {
        path();
        ctx.lineTo(xOf(n - 1), padT + plotH); ctx.lineTo(xOf(0), padT + plotH); ctx.closePath();
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, rising ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad; ctx.fill();
      }
      path();
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    }

    const last = visible[n - 1];
    const ly = yOf(last.c);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ink(0.25); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = last.c >= last.o ? up : down;
    ctx.fillRect(plotW, ly - 8, padR, 16);
    ctx.fillStyle = ground; ctx.textAlign = "center";
    ctx.fillText(`$${last.c.toFixed(2)}`, plotW + padR / 2, ly);

    if (hover && hover.i >= 0 && hover.i < n) {
      ctx.strokeStyle = ink(0.2); ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(xOf(hover.i), padT); ctx.lineTo(xOf(hover.i), padT + plotH); ctx.moveTo(0, hover.y); ctx.lineTo(plotW, hover.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [visible, chartType, hover, resolution.seconds, paint]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const wide = window.matchMedia("(min-width: 80rem)");
    // Below the locked-viewport layout a plain wheel scrolls the page; ctrl+wheel zooms.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !wide.matches) return;
      event.preventDefault();
      setView((v) => ({ ...v, count: Math.round(Math.min(Math.max(v.count * (event.deltaY > 0 ? 1.15 : 0.87), 15), total)) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [total]);

  const slotWidth = () => ((wrapRef.current?.clientWidth ?? 1) - 64) / count;
  const hovered = hover && hover.i >= 0 && hover.i < visible.length ? visible[hover.i] : null;
  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 cursor-crosshair select-none"
      onMouseDown={(event) => { drag.current = { x: event.clientX, startOffset: offset }; }}
      onMouseMove={(event) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        if (drag.current) {
          const start = drag.current.startOffset;
          const shift = Math.round((event.clientX - drag.current.x) / slotWidth());
          setView((v) => ({ ...v, offset: start + shift }));
        } else setHover({ y: event.clientY - rect.top, i: Math.floor((event.clientX - rect.left) / slotWidth()) });
      }}
      onMouseUp={() => { drag.current = null; }}
      onMouseLeave={() => { drag.current = null; setHover(null); }}
    >
      <canvas ref={canvasRef} className="block" />
      {hovered ? (
        <div className="tnum pointer-events-none absolute left-2 top-2 flex gap-3 rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1 text-[11px] text-[var(--t-text-3)]">
          <span>O <b className="font-medium text-[var(--t-text)]">{hovered.o.toFixed(2)}</b></span><span>H <b className="font-medium text-[var(--t-up)]">{hovered.h.toFixed(2)}</b></span>
          <span>L <b className="font-medium text-[var(--t-down)]">{hovered.l.toFixed(2)}</b></span><span>C <b className="font-medium text-[var(--t-text)]">{hovered.c.toFixed(2)}</b></span>
          <span>{new Date(hovered.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Where a market's price comes from, for its chart caption. */
function priceSource(symbol: string): string {
  return isReporterPriced(v3MarketFor(symbol)) ? "PreStocks (reporter on-chain)" : "Pyth";
}
