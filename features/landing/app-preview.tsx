"use client";
/* eslint-disable @next/next/no-img-element -- static logos */

// The landing's floating app window: a small, live copy of the terminal in
// its own design tokens (`terminal dark`). The TSLA book streams from the
// MagicBlock rollup, transactions and pre-IPO prices come from the market-maker
// service, the chart is Pyth history; only the Portfolio tab is an example.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/ui/brand-mark";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { MM_SERVICE_URL, V3_MARKETS, marketBase, marketLogo, marketPair } from "@/lib/v3-markets";
import type { ErTxSample } from "@/lib/er-latency";
import type { Candle } from "@/features/trading/use-candles";
import { useV3Book, type BookLevel } from "@/features/trading/use-v3-book";
import css from "./preview.module.css";

export interface PerpDemoData {
  symbol: string;
  name: string;
  price: number | null;
  candles: Candle[];
  maxLeverage: number;
  initialMarginBps: number;
}

const TABS = [
  { id: "trade", label: "Trade" },
  { id: "pre-ipo", label: "Pre-IPO" },
  { id: "launch", label: "Launch" },
  { id: "portfolio", label: "Portfolio" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Auto-tour: each tab shows this long, once, while the window is in view. */
const TOUR_MS = 6_000;
const BOOK_LEVELS = 8;
const FEED_ROWS = 6;
const DEMO_AMOUNT = 250;
const DEMO_LEVERAGE = 3;
const KIND: Record<string, string> = { quote: "Quote", replace: "Requote", cancel: "Cancel", take: "Taker fill" };
const TSLA = V3_MARKETS.find((m) => m.symbol === "TSLA-PERP") ?? V3_MARKETS[0];
const PRE_IPO = V3_MARKETS.filter((m) => m.kind === "pre-ipo");

const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MIN_SEC = new Intl.DateTimeFormat([], { hour12: false, minute: "2-digit", second: "2-digit" });
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${USD.format(n)}`);

/** Market-maker service: recent rollup transactions (live over SSE) and each market's last price. */
function useMakerFeed(enabled: boolean) {
  const [rows, setRows] = useState<ErTxSample[]>([]);
  const [prices, setPrices] = useState<Record<string, { price: number; resting: number }>>({});
  const arrivals = useRef<number[]>([]);
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !MM_SERVICE_URL) return;
    let stopped = false;
    const status = () => {
      if (document.hidden) return;
      void fetch(`${MM_SERVICE_URL}/v1/mm/status`).then((r) => r.json()).then((s: { recent?: ErTxSample[]; markets?: Record<string, { lastPrice?: number; resting?: number }> }) => {
        if (stopped) return;
        setRows((current) => (current.length ? current : (s.recent ?? []).filter((r) => r.ok).slice(0, FEED_ROWS)));
        setPrices(Object.fromEntries(Object.entries(s.markets ?? {}).map(([k, v]) => [k, { price: v.lastPrice ?? 0, resting: v.resting ?? 0 }])));
      }).catch(() => undefined);
    };
    status();
    const timer = setInterval(status, 10_000);
    const stream = new EventSource(`${MM_SERVICE_URL}/v1/mm/stream`);
    stream.addEventListener("tx", (event) => {
      const row = JSON.parse((event as MessageEvent<string>).data) as ErTxSample;
      if (!row.ok) return;
      arrivals.current.push(Date.now());
      setRows((current) => (current.some((r) => r.signature === row.signature) ? current : [row, ...current].slice(0, FEED_ROWS)));
    });
    // Transactions per second over the last 10 s of the stream.
    const meter = setInterval(() => {
      const cutoff = Date.now() - 10_000;
      arrivals.current = arrivals.current.filter((t) => t > cutoff);
      if (arrivals.current.length) setRate(arrivals.current.length / 10);
    }, 1_000);
    return () => { stopped = true; clearInterval(timer); clearInterval(meter); stream.close(); };
  }, [enabled]);

  return { rows, prices, rate };
}

function MarketLogo({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const src = marketLogo(symbol);
  return src ? <img src={src} alt="" width={size} height={size} className={css.logo} /> : <span className={css.logo} style={{ width: size, height: size }} />;
}

export function AppPreview({ demo }: { demo: PerpDemoData }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<TabId>("trade");
  const [revealed, setRevealed] = useState(false);
  const [inView, setInView] = useState(false);
  const [touring, setTouring] = useState(true);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      if (e.isIntersecting) setRevealed(true);
      setInView(e.intersectionRatio >= 0.6);
    }, { threshold: [0, 0.2, 0.6] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // One pass through the tabs, then back to Trade; any click or key ends it.
  useEffect(() => {
    if (!touring || !inView || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setTimeout(() => {
      const next = TABS.findIndex((t) => t.id === tab) + 1;
      if (next >= TABS.length) { setTab("trade"); setTouring(false); } else setTab(TABS[next].id);
    }, TOUR_MS);
    return () => clearTimeout(timer);
  }, [tab, touring, inView]);

  const choose = (id: TabId) => { setTouring(false); setTab(id); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.id === tab);
    const next = (idx + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    choose(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const feed = useMakerFeed(revealed);
  // The book streams once the window is on screen (kept across tabs: no reconnect on return).
  const book = useV3Book(publicMarketApiUrl, revealed ? TSLA.core : undefined, true);
  const showProgress = touring && inView;

  return (
    <div ref={panelRef} className={`${css.panel} ${revealed ? css.revealed : ""} terminal dark`}>
      <header className={css.appBar}>
        <span className={css.brand}><BrandMark size={20} darkSurface />Equinox</span>
        <span className={css.badge}>Devnet preview</span>
        <nav className={css.nav} role="tablist" aria-label="App preview" onKeyDown={onKey}>
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[i] = el; }}
              type="button"
              role="tab"
              id={`preview-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="preview-screen"
              tabIndex={tab === t.id ? 0 : -1}
              className={css.navTab}
              onClick={() => choose(t.id)}
            >
              {t.label}
              {tab === t.id && <span key={`${t.id}-${showProgress}`} className={css.navLine} data-tour={showProgress} style={{ animationDuration: `${TOUR_MS}ms` }} aria-hidden />}
            </button>
          ))}
        </nav>
        <span className={css.barRight}>
          <span className={css.speed} title="Market-maker transactions confirmed in the rollup, per second">
            <span className={css.dot} aria-hidden />
            <span className="tnum">{feed.rate === null ? "live" : `${feed.rate.toFixed(1)} tx/s`}</span>
          </span>
          <Link href="/trade" className={css.launch}>Launch App</Link>
        </span>
      </header>

      <div id="preview-screen" role="tabpanel" aria-labelledby={`preview-tab-${tab}`} className={css.screens}>
        <div key={tab} className={css.screen}>
          {tab === "trade" && <TradeScreen demo={demo} bids={book.bids} asks={book.asks} live={book.status === "live"} active={revealed} />}
          {tab === "pre-ipo" && <PreIpoScreen prices={feed.prices} />}
          {tab === "launch" && <LaunchScreen />}
          {tab === "portfolio" && <PortfolioScreen price={demo.price} />}
        </div>
        <Feed rows={feed.rows} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Trade */

function TradeScreen({ demo, bids, asks, live, active }: { demo: PerpDemoData; bids: BookLevel[]; asks: BookLevel[]; live: boolean; active: boolean }) {
  const day = demo.candles.slice(-24);
  const change = day.length >= 2 && day[0].o > 0 ? ((day.at(-1)!.c - day[0].o) / day[0].o) * 100 : null;
  const high = day.length ? Math.max(...day.map((c) => c.h)) : null;
  const low = day.length ? Math.min(...day.map((c) => c.l)) : null;
  const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null;
  const price = mid ?? demo.price;
  const up = (change ?? 0) >= 0;

  return (
    <div>
      <div className={css.marketBar}>
        <span className={css.pair}><MarketLogo symbol={demo.symbol} /><span>{marketPair(demo.symbol)}</span><span className={css.perp}>PERP</span></span>
        <span className={`${css.lastPrice} tnum`} data-up={up}>{price === null ? "—" : USD.format(price)}</span>
        {change !== null && <span className={`${css.change} tnum`} data-up={up}>{up ? "+" : "−"}{Math.abs(change).toFixed(2)}%</span>}
        <span className={css.stat}><span>24h High</span><b className="tnum">{high === null ? "—" : USD.format(high)}</b></span>
        <span className={css.stat}><span>24h Low</span><b className="tnum">{low === null ? "—" : USD.format(low)}</b></span>
        <span className={css.stat}><span>Oracle</span><b>Pyth</b></span>
      </div>

      <div className={css.grid}>
        <section className={css.chartCol} aria-label="Price chart">
          <div className={css.head}><span className={css.headTab} data-active="true">Chart</span><span className={css.headTab}>Depth</span><span className={css.headNote}>1H · Pyth history</span></div>
          <PriceChart candles={demo.candles.slice(-24 * 7)} up={up} active={active} />
        </section>

        <section className={css.bookCol} aria-label="Order book">
          <div className={css.head}><span className={css.headTab} data-active="true">Book</span><span className={css.chip}>MagicBlock rollup</span></div>
          <Book bids={bids} asks={asks} live={live} />
        </section>

        <section className={css.ticketCol} aria-label="Order ticket">
          <Ticket demo={demo} price={price} />
        </section>
      </div>

    </div>
  );
}

/** The market maker's rollup transactions, live: shown under every tab. */
function Feed({ rows }: { rows: ErTxSample[] }) {
  return (
    <section className={css.feed} aria-label="Live rollup transactions">
      <div className={css.head}>
        <span className={css.dot} aria-hidden />
        <span className={css.feedTitle}>Delegated session · live</span>
        <span className={css.headNote}>each row: sent → in a rollup block</span>
      </div>
      <div className={css.feedRows}>
        {rows.length === 0 && <span className={css.muted}>connecting to the market maker…</span>}
        {rows.map((row, i) => (
          <div key={row.signature} className={`${css.txCard} glass-card ${i === 0 ? "card-enter" : ""}`}>
            <span className={`${css.muted} tnum`}>{MIN_SEC.format(row.at)}</span>
            <span className={css.txWhat}>
              <b>{KIND[row.kind] ?? row.kind}</b>
              {row.side && <span className="tnum" data-side={row.side}> {row.side === "bid" ? "B" : "S"} {row.quantity}</span>}
              {row.price != null && <span className={`${css.muted} tnum`}> @ {USD.format(row.price)}</span>}
              <span className={css.txMarket}>{marketBase(row.market ?? "TSLA-PERP")}</span>
            </span>
            <span className={`${css.ms} tnum`}>{row.blockMs ?? row.ms ?? "—"} ms</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PriceChart({ candles, up, active }: { candles: Candle[]; up: boolean; active: boolean }) {
  const W = 560, H = 340, PAD = 14;
  const chart = useMemo(() => {
    if (candles.length < 2) return null;
    const lo = Math.min(...candles.map((c) => c.l)), hi = Math.max(...candles.map((c) => c.h));
    const pad = (hi - lo || 1) * 0.08;
    const x = (i: number) => (i / (candles.length - 1)) * (W - 52);
    const y = (p: number) => PAD + (1 - (p - (lo - pad)) / (hi - lo + pad * 2)) * (H - PAD * 2);
    const line = candles.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.c).toFixed(1)}`).join(" ");
    const ticks = [0.15, 0.5, 0.85].map((k) => lo - pad + (hi - lo + pad * 2) * (1 - k));
    return { line, area: `${line} L${x(candles.length - 1).toFixed(1)},${H} L0,${H} Z`, ticks, y, lastY: y(candles.at(-1)!.c) };
  }, [candles]);
  if (!chart) return <div className={css.chartEmpty}>loading Pyth history…</div>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={css.chart} data-up={up} aria-hidden>
      <defs>
        <linearGradient id="preview-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {chart.ticks.map((p) => (
        <g key={p}>
          <line x1={0} x2={W - 52} y1={chart.y(p)} y2={chart.y(p)} className={css.gridLine} />
          <text x={W - 4} y={chart.y(p) + 3} textAnchor="end" className={css.axis}>{USD.format(p)}</text>
        </g>
      ))}
      <path d={chart.area} fill="url(#preview-area)" />
      <path d={chart.line} className={`${css.line} ${active ? css.draw : ""}`} pathLength={1} />
      <line x1={0} x2={W - 52} y1={chart.lastY} y2={chart.lastY} className={css.lastLine} />
    </svg>
  );
}

function Book({ bids, asks, live }: { bids: BookLevel[]; asks: BookLevel[]; live: boolean }) {
  const side = (levels: BookLevel[]) => {
    let total = 0;
    return levels.slice(0, BOOK_LEVELS).map((l) => ({ ...l, total: (total += l.size) }));
  };
  const a = side(asks), b = side(bids);
  const max = Math.max(a.at(-1)?.total ?? 0, b.at(-1)?.total ?? 0, 1);
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
  const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null;
  const row = (l: { price: number; size: number; total: number }, kind: "bid" | "ask") => (
    <div key={`${kind}-${l.price}`} className={css.level} data-side={kind} style={{ ["--depth" as string]: `${(l.total / max) * 100}%` }}>
      <span className="tnum">{USD.format(l.price)}</span>
      <span className="tnum">{l.size}</span>
      <span className="tnum">{l.total}</span>
    </div>
  );
  if (!live && !a.length && !b.length) return <div className={css.bookEmpty}>{"connecting to the rollup…"}</div>;
  return (
    <div className={css.book}>
      <div className={css.levelHead}><span>Price</span><span>Size</span><span>Total</span></div>
      <div className={css.asks}>{[...a].reverse().map((l) => row(l, "ask"))}</div>
      <div className={css.mid}><span className="tnum">{mid === null ? "—" : USD.format(mid)}</span><span className={css.muted}>spread <span className="tnum">{spread === null ? "—" : spread.toFixed(2)}</span></span></div>
      <div>{b.map((l) => row(l, "bid"))}</div>
    </div>
  );
}

function Ticket({ demo, price }: { demo: PerpDemoData; price: number | null }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [amount, setAmount] = useState(0);
  useEffect(() => {
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1_200;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = duration ? Math.min((t - t0) / duration, 1) : 1;
      setAmount(DEMO_AMOUNT * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const base = marketBase(demo.symbol);
  const size = price ? Math.floor((amount * DEMO_LEVERAGE) / price) : 0;
  const notional = price ? size * price : 0;
  return (
    <>
      <div className={css.head}><span className={css.headTab} data-active="true">Market</span><span className={css.headTab}>Limit</span></div>
      <div className={css.ticket}>
        <div className={css.sides}>
          <button type="button" data-side="long" data-active={side === "long"} onClick={() => setSide("long")}>Buy<small>takes the best ask</small></button>
          <button type="button" data-side="short" data-active={side === "short"} onClick={() => setSide("short")}>Sell<small>hits the best bid</small></button>
        </div>
        <label className={css.fieldLabel}>Amount</label>
        <div className={css.field}><span className="tnum">{USD.format(amount)}</span><span className={css.muted}>USDC</span></div>
        <div className={css.fieldLabel}><span>Size multiplier</span><span className={`${css.accentText} tnum`}>{DEMO_LEVERAGE.toFixed(1)}×</span></div>
        <div className={css.slider} aria-hidden><span style={{ width: `${((DEMO_LEVERAGE - 1) / (demo.maxLeverage - 1)) * 100}%` }} /></div>
        <dl className={css.calc}>
          <div><dt>Size</dt><dd className="tnum">{size} {base}</dd></div>
          <div><dt>Notional</dt><dd className="tnum">{usd(notional)}</dd></div>
          <div><dt>Initial margin</dt><dd className="tnum">{usd((notional * demo.initialMarginBps) / 10_000)}</dd></div>
        </dl>
        <Link href="/trade" className={css.place} data-side={side}>Place order · {side === "long" ? "Long" : "Short"} {size} {base}</Link>
        <p className={css.fine}>Signed silently by your trading key, matched in the rollup.</p>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- Pre-IPO */

function PreIpoScreen({ prices }: { prices: Record<string, { price: number; resting: number }> }) {
  return (
    <div className={css.pad}>
      <div className={css.screenHead}>
        <div><h3>Pre-IPO perpetuals</h3><p className={css.muted}>Priced on-chain from PreStocks tokens, matched in the rollup like TSLA.</p></div>
        <span className={css.chip}><img src="/landing/prestocks.png" alt="" width={14} height={14} className={css.logo} />PreStocks</span>
      </div>
      <div className={css.cards}>
        {PRE_IPO.map((m) => {
          const live = prices[m.symbol];
          return (
            <Link key={m.symbol} href={`/trade?market=${m.symbol}`} className={`${css.marketCard} glass-card`}>
              <span className={css.pair}><MarketLogo symbol={m.symbol} size={26} /><span>{marketPair(m.symbol)}</span><span className={css.perp}>PERP</span></span>
              <span className={`${css.cardPrice} tnum`}>{usd(live?.price)}</span>
              <span className={css.muted}>{live ? <><span className="tnum">{live.resting}</span> resting orders · 5× max</> : "loading…"}</span>
              <span className={css.cardActions}><span data-side="long">Long</span><span data-side="short">Short</span></span>
            </Link>
          );
        })}
      </div>
      <Link href="/pre-ipo" className={`${css.basket} glass-card`}>
        <span className={css.basketLogos}>{["OPENAI-PERP", "ANTHROPIC-PERP"].map((s) => <MarketLogo key={s} symbol={s} size={24} />)}</span>
        <span><b>AI labs basket</b><span className={css.muted}> · OpenAI + Anthropic, both legs in one click</span></span>
        <span className={css.accentText}>Open baskets →</span>
      </Link>
    </div>
  );
}

/* --------------------------------------------------------------- Launch */

const LAUNCH_STEPS = [
  { title: "New pair", body: "Mint 1B tokens on a Meteora Dynamic Bonding Curve, priced in USDC.", fill: 12 },
  { title: "Final stretch", body: "Past 60% of the USDC it needs, a launch moves up the board.", fill: 68 },
  { title: "Graduated", body: "Liquidity migrates to a Meteora DAMM v2 pool, part locked for good.", fill: 100 },
  { title: "Equinox perp", body: "The pool price is posted on-chain; the token trades long or short up to 5×.", fill: 100 },
] as const;

function LaunchScreen() {
  return (
    <div className={css.pad}>
      <div className={css.screenHead}>
        <div><h3>From launch to perp</h3><p className={css.muted}>Stock-themed tokens on bonding curves, live from the chain.</p></div>
        <span className={css.chip}><img src="/landing/meteora.svg" alt="" width={14} height={14} />Meteora DBC</span>
      </div>
      <div className={css.steps}>
        {LAUNCH_STEPS.map((s, i) => (
          <div key={s.title} className={`${css.step} glass-card`}>
            <span className={css.stepNo}>{i + 1}</span>
            <b>{s.title}</b>
            <p className={css.muted}>{s.body}</p>
            <span className={css.progress} data-done={s.fill === 100}><span style={{ width: `${s.fill}%` }} /></span>
          </div>
        ))}
      </div>
      <Link href="/launch" className={css.place} data-side="long">Create a launch</Link>
    </div>
  );
}

/* ------------------------------------------------------------ Portfolio */

function PortfolioScreen({ price }: { price: number | null }) {
  const mark = price ?? 380;
  const entry = mark * 0.985, size = 2, collateral = 250;
  const pnl = (mark - entry) * size;
  return (
    <div className={css.pad}>
      <div className={css.screenHead}>
        <div><h3>Portfolio</h3><p className={css.muted}>An example account, marked at the live TSLA price.</p></div>
        <span className={css.chip}>Example</span>
      </div>
      <div className={css.summary}>
        {[["Equity", usd(collateral + 750 + pnl)], ["Available", usd(750)], ["Unrealized PnL", `${pnl >= 0 ? "+" : "−"}${usd(Math.abs(pnl))}`]].map(([k, v]) => (
          <div key={k} className="glass-card"><span className={css.muted}>{k}</span><b className="tnum" data-up={k === "Unrealized PnL" ? pnl >= 0 : undefined}>{v}</b></div>
        ))}
      </div>
      <div className={css.sectionLabel}>Positions</div>
      <div className={`${css.position} glass-card`}>
        <div className={css.positionTop}>
          <span className={css.pair}><MarketLogo symbol="TSLA-PERP" /><span>TSLA/USDC</span><span className={css.long}>Long {size}</span><span className={css.muted}>{((size * mark) / collateral).toFixed(1)}×</span></span>
          <span className={`${css.pnl} tnum`} data-up={pnl >= 0}>{pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl))} ({((pnl / collateral) * 100).toFixed(1)}%)</span>
          <span className={css.positionBtns}><span>50%</span><span data-close>Close</span></span>
        </div>
        <div className={css.positionStats}>
          {[["Value", usd(size * mark)], ["Entry", USD.format(entry)], ["Mark", USD.format(mark)], ["Collateral", usd(collateral)]].map(([k, v]) => <span key={k}><span className={css.muted}>{k}</span> <span className="tnum">{v}</span></span>)}
          <span><span className={css.muted}>Health</span> <span className={css.healthy}>healthy</span></span>
        </div>
      </div>
      <div className={css.sectionLabel}>Open orders</div>
      <div className={`${css.order} glass-card`}>
        <span className={css.pair}><MarketLogo symbol="OPENAI-PERP" size={20} /><span>OPENAI/USDC</span></span>
        <span className={css.muted}>Limit · Buy</span>
        <span className="tnum">1 @ {usd(1300)}</span>
        <span className={css.positionBtns}><span>Replace</span><span>Cancel</span></span>
      </div>
    </div>
  );
}
