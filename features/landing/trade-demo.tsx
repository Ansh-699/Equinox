"use client";

// The trade screen inside the landing's floating app panel (Onyx TradeDemo),
// re-cut for a perp: the chart is REAL Pyth history ending at the verified
// on-chain price, and the order math is the same sizing the terminal uses
// (features/trading/order-ticket.tsx). `active` = panel revealed AND tab shown.

import { useEffect, useMemo, useState } from "react";
import type { Candle } from "@/features/trading/use-candles";
import styles from "./TradeDemo.module.css";

export function seededRng(seedStr: string): () => number {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  let a = seed || 0x9e3779b9;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PerpDemoData {
  symbol: string;
  name: string;
  price: number | null;
  candles: Candle[];
  maxLeverage: number;
  initialMarginBps: number;
}

const DEMO_AMOUNT = 250;
const DEMO_LEVERAGE = 3;
const COUNT_MS = 1600;
const CHART_W = 520;
const CHART_H = 210;
const PAD_L = 44;
const PAD_R = 10;
const PAD_Y = 16;

const fmt = (n: number, dp = 2) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function TradeScreen({ data, active }: { data: PerpDemoData; active: boolean }) {
  const [amount, setAmount] = useState(0);
  const [side, setSide] = useState<"long" | "short">("long");

  useEffect(() => {
    if (!active) return;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : COUNT_MS;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = duration ? Math.min((t - t0) / duration, 1) : 1;
      setAmount(DEMO_AMOUNT * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const chart = useMemo(() => {
    const pts = data.candles.map((c) => [c.t * 1000, c.c] as [number, number]);
    if (pts.length < 2) return null;
    const lo = Math.min(...pts.map(([, p]) => p));
    const hi = Math.max(...pts.map(([, p]) => p));
    const pad = (hi - lo || 1) * 0.1;
    const min = lo - pad;
    const max = hi + pad;
    const t0 = pts[0][0];
    const span = Math.max(pts[pts.length - 1][0] - t0, 1);
    const x = (t: number) => PAD_L + ((t - t0) / span) * (CHART_W - PAD_L - PAD_R);
    const y = (p: number) => PAD_Y + (1 - (p - min) / (max - min)) * (CHART_H - PAD_Y * 2);
    const line = pts.map(([t, p], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
    const label = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => min + (max - min) * k);
    return { pts, x, y, line, ticks, delta: pts[pts.length - 1][1] - pts[0][1], axis: [t0, t0 + span / 2, t0 + span].map(label) };
  }, [data.candles]);

  const [hover, setHover] = useState<number | null>(null);
  const onChartMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (((e.clientX - rect.left) / rect.width) * CHART_W - PAD_L) / (CHART_W - PAD_L - PAD_R);
    setHover(Math.max(0, Math.min(chart.pts.length - 1, Math.round(k * (chart.pts.length - 1)))));
  };

  const price = data.price ?? chart?.pts.at(-1)?.[1] ?? null;
  const delta = chart?.delta ?? 0;
  const shares = price ? Math.floor((amount * DEMO_LEVERAGE) / price) : 0;
  const notional = price ? shares * price : 0;
  const ticker = data.symbol.replace("-PERP", "");

  return (
    <div>
      <div className={styles.body}>
        <div className={styles.chartSide}>
          <div className={styles.marketHead}>
            <span className={styles.fixture}>{data.name} · perpetual</span>
            <span className={styles.title}>{data.symbol}</span>
          </div>
          <div className={styles.priceRow}>
            <span className={styles.bigPrice}>{price === null ? "—" : `$${fmt(price)}`}</span>
            <span className={styles.delta} data-up={delta >= 0}>{delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}</span>
            <span className={styles.chipLabel}>Pyth index</span>
          </div>
          {chart ? (
            <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className={styles.chart} aria-label={`${data.symbol} price history`} onMouseMove={onChartMove} onMouseLeave={() => setHover(null)}>
              {chart.ticks.map((p) => (
                <g key={p}>
                  <line x1={PAD_L} x2={CHART_W - PAD_R} y1={chart.y(p)} y2={chart.y(p)} className={styles.grid} />
                  <text x={2} y={chart.y(p) + 3} className={styles.gridLabel}>${p.toFixed(0)}</text>
                </g>
              ))}
              {chart.axis.map((label, i) => (
                <text key={label + i} x={i === 0 ? PAD_L : i === 1 ? (PAD_L + CHART_W - PAD_R) / 2 : CHART_W - PAD_R} y={CHART_H - 2} textAnchor={i === 0 ? "start" : i === 1 ? "middle" : "end"} className={styles.gridLabel}>{label}</text>
              ))}
              <path d={chart.line} className={`${delta >= 0 ? styles.lineYes : styles.lineNo} ${active ? styles.draw : ""}`} />
              {hover !== null && (() => {
                const [t, p] = chart.pts[hover];
                const hx = chart.x(t);
                const bx = hx > CHART_W / 2 ? hx - 128 : hx + 10;
                return (
                  <g className={styles.hoverLayer}>
                    <line x1={hx} x2={hx} y1={PAD_Y} y2={CHART_H - PAD_Y} className={styles.crosshair} />
                    <circle cx={hx} cy={chart.y(p)} r={3.5} className={delta >= 0 ? styles.dotYes : styles.dotNo} />
                    <rect x={bx} y={PAD_Y + 4} width={118} height={38} rx={9} className={styles.tipBox} />
                    <text x={bx + 12} y={PAD_Y + 22} className={`${styles.tipText} ${styles.tipYes}`}>${fmt(p)}</text>
                    <text x={bx + 12} y={PAD_Y + 36} className={styles.tipText}>{new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}</text>
                  </g>
                );
              })()}
            </svg>
          ) : (
            <p className={styles.chipLabel}>price history loads from Pyth</p>
          )}
          <div className={styles.timeframes} aria-hidden><span>1D</span><span data-active="true">1W</span><span>1M</span></div>
          <p className={styles.chartCaption}>real Pyth history · live price verified on Solana</p>
        </div>

        <div className={styles.orderSide}>
          <div className={styles.sideToggle}>
            <button type="button" data-kind="yes" data-active={side === "long"} onClick={() => setSide("long")}>Long</button>
            <button type="button" data-kind="no" data-active={side === "short"} onClick={() => setSide("short")}>Short</button>
          </div>
          <div className={styles.buySellTabs} aria-hidden><span>Market</span><span data-active="true">Limit</span></div>
          <div className={styles.amount}>
            <span className={styles.amountLabel}>Amount</span>
            <span className={styles.amountValue}>{fmt(amount)} <span className={styles.unit}>USDC</span></span>
          </div>
          <div className={styles.chips} aria-hidden><span>1×</span><span data-active="true">{DEMO_LEVERAGE}×</span><span>{data.maxLeverage}×</span><span>MAX</span></div>
          <span className={styles.buyBtn} role="presentation">{side === "long" ? "Long" : "Short"} {ticker}</span>
          <dl className={styles.calc}>
            <div><dt>Size</dt><dd>{shares} {ticker}</dd></div>
            <div><dt>Notional</dt><dd>${fmt(notional)}</dd></div>
            <div><dt>Initial margin</dt><dd className={styles.toWin}>${fmt((notional * data.initialMarginBps) / 10_000)}</dd></div>
          </dl>
          <p className={styles.orderCaption}>sized exactly as the terminal does · matched in a MagicBlock rollup</p>
        </div>
      </div>

      <div className={styles.outcomes}>
        <div className={styles.outcomeRow}>
          <span className={styles.outcomeName}>Long {ticker}</span>
          <span className={styles.outcomePrice}>{price === null ? "—" : `$${fmt(price)}`}</span>
          <span className={styles.delta} data-up={delta >= 0}>{delta >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}</span>
          <span className={styles.oYes} role="presentation">Open long</span>
        </div>
        <div className={styles.outcomeRow}>
          <span className={styles.outcomeName}>Short {ticker}</span>
          <span className={styles.outcomePrice}>{price === null ? "—" : `$${fmt(price)}`}</span>
          <span className={styles.delta} data-up={delta < 0}>{delta < 0 ? "▲" : "▼"} {fmt(Math.abs(delta))}</span>
          <span className={styles.oNo} role="presentation">Open short</span>
        </div>
      </div>
    </div>
  );
}
