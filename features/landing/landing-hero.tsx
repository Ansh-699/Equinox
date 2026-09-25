"use client";
/* eslint-disable @next/next/no-img-element -- static brand marks, no optimisation needed */

// Landing hero + floating preview panel (Onyx LandingHero): the tab pill is a
// real tablist that swaps the PANEL CONTENT in place — only "Launch App" and
// the panel's "Launch" button leave the page. Preview screens reuse live data
// where it exists and tag everything illustrative as "sample".

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/ui/brand-mark";
import { TradeScreen, seededRng, type PerpDemoData } from "./trade-demo";
import { ChromeCta } from "./chrome-cta";
import demoStyles from "./TradeDemo.module.css";
import styles from "./landing.module.css";

const SPONSORS = [["MagicBlock", "/landing/magicblock.jpg"], ["PreStocks", "/landing/prestocks.png"], ["Meteora", "/landing/meteora.svg"]] as const;

export interface PreviewMarket { symbol: string; name: string; price: number | null; changePct: number | null; live: boolean }
export interface ActivityRow { side: "long" | "short"; role: "Maker" | "Taker"; size: number; price: number; t: number }

const TABS = [
  { id: "trade", label: "Trade" },
  { id: "markets", label: "Markets" },
  { id: "portfolio", label: "Portfolio" },
  { id: "activity", label: "Activity" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function timeAgo(t: number): string {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
const fmt = (n: number, dp = 2) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

function Spark({ seed, up }: { seed: string; up: boolean }) {
  const rnd = seededRng(seed);
  let v = up ? 9 : 4;
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    v = Math.min(15, Math.max(2, v + (rnd() - (up ? 0.58 : 0.42)) * 3.2));
    pts.push(`${(i / 15) * 62},${v.toFixed(1)}`);
  }
  return <svg viewBox="0 0 62 17" className={demoStyles.spark} aria-hidden><polyline points={pts.join(" ")} data-up={up} /></svg>;
}

function MarketsScreen({ markets }: { markets: PreviewMarket[] }) {
  return (
    <div>
      <div className={demoStyles.screenNote}>perpetual markets · live card from devnet · undeployed markets tagged “soon”</div>
      <div className={demoStyles.marketsScreen}>
        {markets.map((m) => {
          const up = (m.changePct ?? 0) >= 0;
          return (
            <div key={m.symbol} className={demoStyles.previewCard}>
              <span className={demoStyles.previewCardTop}>
                <span className={demoStyles.fixture}>{m.name}</span>
                <span className={demoStyles.sampleTag}>{m.live ? "live" : "soon"}</span>
              </span>
              <span className={demoStyles.previewTitle}>{m.symbol}</span>
              <span className={demoStyles.previewMid}>
                <span className={demoStyles.previewChance}>{m.price === null ? "—" : `$${fmt(m.price)}`}</span>
                <Spark seed={m.symbol} up={up} />
              </span>
              <span className={demoStyles.previewPrices}>
                <span className={demoStyles.pvYes}>Long</span>
                <span className={demoStyles.pvNo}>Short</span>
              </span>
              <span className={demoStyles.chipLabel}>
                {m.live ? `⚡ MagicBlock matching${m.changePct === null ? "" : ` · ${up ? "+" : "−"}${Math.abs(m.changePct).toFixed(2)}% 24h`}` : "not deployed yet"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlChart() {
  const rnd = seededRng("equinox-pl");
  const W = 730;
  const H = 190;
  let v = 145;
  const pts: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    v = Math.min(172, Math.max(36, v + (rnd() - 0.62) * 18));
    pts.push([12 + (i / 39) * (W - 24), i === 39 ? 40 : v]);
  }
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={demoStyles.plChart} aria-hidden>
      {[0.25, 0.5, 0.75].map((k) => <line key={k} x1={12} x2={W - 12} y1={H * k} y2={H * k} className={demoStyles.plGrid} />)}
      <path d={d} />
      <circle cx={last[0]} cy={last[1]} r={4} />
    </svg>
  );
}

/** Portfolio screen: sample figures, marked as such, priced at the live index where known. */
function PortfolioScreen({ price }: { price: number | null }) {
  const mark = price ?? 250;
  const rows = [
    { key: "tsla-long", symbol: "TSLA-PERP", side: "Long", size: 6, entry: mark * 0.97 },
    { key: "tsla-short", symbol: "TSLA-PERP", side: "Short", size: 2, entry: mark * 1.012 },
  ].map((r) => {
    const pnl = (r.side === "Long" ? 1 : -1) * r.size * (mark - r.entry);
    return { ...r, value: r.size * mark, pnl, pct: (pnl / (r.size * r.entry)) * 100 };
  });
  return (
    <div className={demoStyles.pfScreen}>
      <div className={demoStyles.pfTop}>
        <div className={demoStyles.pfLeft}>
          <div className={`${demoStyles.pfCard} ${demoStyles.pfGreen}`}>
            <span className={demoStyles.pfCardLabel}>◔ Equity</span>
            <span className={demoStyles.pfBig}>1,246.02 <span className={demoStyles.pfUnit}>USDC</span></span>
            <svg viewBox="0 0 44 30" className={demoStyles.pfArrow} aria-hidden><path d="M2 26 L14 15 L22 20 L40 4 M30 4 h10 v10" /></svg>
          </div>
          <div className={`${demoStyles.pfCard} ${demoStyles.pfBlue}`}>
            <span className={demoStyles.pfCardLabel}>◎ Free collateral</span>
            <span className={demoStyles.pfBig}>832.40 <span className={demoStyles.pfUnit}>USDC</span></span>
          </div>
          <div className={demoStyles.pfBtns}>
            <span className={demoStyles.depositBtn} role="presentation"><span className={demoStyles.pfBtnIcon}>↓</span> Deposit</span>
            <span className={demoStyles.withdrawBtn} role="presentation"><span className={demoStyles.pfBtnIcon} data-ghost="true">↑</span> Withdraw</span>
          </div>
        </div>
        <div className={demoStyles.plCard}>
          <div className={demoStyles.plHead}>
            <span className={demoStyles.chipLabel}>📊 Profit/Loss</span>
            <span className={demoStyles.plValue}>+118.62 USDC <span className={demoStyles.plPct}>▲ 10.5%</span></span>
            <span className={demoStyles.chipLabel}>past month</span>
          </div>
          <PlChart />
        </div>
      </div>
      <div className={demoStyles.posTable}>
        <div className={demoStyles.posHead}><span>Positions</span><span>Mark</span><span>Value</span></div>
        {rows.map((r) => (
          <div key={r.key} className={demoStyles.posRow}>
            <div className={demoStyles.positionMain}>
              <span className={demoStyles.previewTitle}>{r.symbol}</span>
              <span className={demoStyles.chipLabel}>
                <span className={demoStyles.posSide} data-side={r.side === "Long" ? "Yes" : "No"}>{r.side}</span> {r.size} shares at ${fmt(r.entry)}
              </span>
            </div>
            <span className={demoStyles.posCur}>${fmt(mark)}</span>
            <div className={demoStyles.positionNums}>
              <span>{fmt(r.value)}</span>
              <span className={demoStyles.delta} data-up={r.pnl >= 0}>{r.pnl >= 0 ? "+" : "−"}{fmt(Math.abs(r.pnl))} ({Math.abs(r.pct).toFixed(1)}%)</span>
            </div>
          </div>
        ))}
      </div>
      <div className={demoStyles.screenNote}>sample portfolio · marked at the live Pyth index · devnet test USDC</div>
    </div>
  );
}

function ActivityScreen({ activity, real }: { activity: ActivityRow[]; real: boolean }) {
  return (
    <div className={demoStyles.activityScreen}>
      <div className={demoStyles.screenNote}>{real ? "recent fills · decoded from the market's on-chain event shards" : "sample fills · the live feed shows once the market trades"}</div>
      {activity.slice(0, 7).map((a, i) => {
        const side = a.side === "long" ? 1 : 2;
        return (
          <div key={`${a.t}-${i}`} className={demoStyles.activityRow} data-side={side}>
            <span className={demoStyles.activityBadge} data-side={side}>{a.side === "long" ? "Bought" : "Sold"}</span>
            <div className={demoStyles.activityMain}>
              <span className={demoStyles.activityPredicate}>TSLA-PERP · {a.role}</span>
              <span className={demoStyles.chipLabel}>{a.size} shares @ ${fmt(a.price)}</span>
            </div>
            <div className={demoStyles.activityNums}>
              <span className={demoStyles.activityValue} data-side={side}>${fmt(a.size * a.price)}</span>
              <span className={demoStyles.activityWhen}>{timeAgo(a.t)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LandingHero({ demo, markets, activity, realActivity }: { demo: PerpDemoData; markets: PreviewMarket[]; activity: ActivityRow[]; realActivity: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("trade");
  const [revealed, setRevealed] = useState(false);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const [autoCycle, setAutoCycle] = useState(true);

  // Sliding white chip: glide the indicator to the active tab (transform + width only).
  useEffect(() => {
    const measure = () => {
      const el = tabRefs.current[TABS.findIndex((t) => t.id === activeTab)];
      if (el) setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTab]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { setRevealed(true); io.disconnect(); } }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Auto-advance the tabs once the panel fills the viewport, until the visitor takes over.
  useEffect(() => {
    if (!revealed || !autoCycle || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = panelRef.current;
    if (!el) return;
    let inView = false;
    const io = new IntersectionObserver(([e]) => (inView = (e?.intersectionRatio ?? 0) >= 0.9), { threshold: [0, 0.9, 1] });
    io.observe(el);
    const t = setInterval(() => {
      if (!inView || document.hidden) return;
      setActiveTab((prev) => TABS[(TABS.findIndex((x) => x.id === prev) + 1) % TABS.length].id);
    }, 3000);
    return () => { io.disconnect(); clearInterval(t); };
  }, [revealed, autoCycle]);

  function onTabKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    setAutoCycle(false);
    const idx = TABS.findIndex((t) => t.id === activeTab);
    const next = e.key === "ArrowRight" ? (idx + 1) % TABS.length : (idx - 1 + TABS.length) % TABS.length;
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div>
      <section className={styles.hero}>
        <div className={`${styles.heroItem} ${styles.d0}`}>
          <span className={styles.wordmark}>
            <BrandMark size={30} darkSurface />
            EQUINOX
          </span>
        </div>

        <div className={`${styles.heroItem} ${styles.d1}`}>
          <div className={styles.credPill} style={{ padding: "9px 20px" }}>
            <span className={styles.credInner}>
              <span className={styles.credItem}>Built on Solana <img src="/landing/Solana-Round-Logo-PNG.png" alt="Solana" width={16} height={16} className={styles.credLogo} /></span>
              <span className={styles.credDivider} aria-hidden />
              <span className={styles.credItem}>
                Powered by
                <span className={styles.sponsors}>
                  {SPONSORS.map(([name, src]) => (
                    <span key={name} className={styles.sponsor} data-name={name} role="img" aria-label={name}>
                      <img src={src} alt="" width={20} height={20} />
                    </span>
                  ))}
                </span>
              </span>
            </span>
          </div>
        </div>

        <h1 className={`${styles.heroTitle} ${styles.heroItem} ${styles.d2}`}>Perpetual futures on tokenized assets<br />at rollup speed.</h1>

        <p className={`${styles.heroSub} ${styles.heroItem} ${styles.d3}`}>
          Orders match in a MagicBlock Ephemeral Rollup, prices come from Pyth, and your collateral never leaves Solana.
        </p>

        <div className={`${styles.heroItem} ${styles.d4}`}>
          <ChromeCta href="/trade" label="Launch App" />
        </div>

        <div className={`${styles.heroItem} ${styles.d5}`}>
          <div className={styles.pillNav} role="tablist" aria-label="App preview" onKeyDown={onTabKey}>
            {indicator && <span className={styles.pillIndicator} aria-hidden style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }} />}
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[i] = el; }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={activeTab === t.id}
                aria-controls="landing-preview-panel"
                tabIndex={activeTab === t.id ? 0 : -1}
                data-primary={activeTab === t.id}
                onClick={() => { setAutoCycle(false); setActiveTab(t.id); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.panelZone}>
        <div ref={panelRef} id="landing-preview-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} className={`${demoStyles.panel} ${revealed ? demoStyles.revealed : ""}`}>
          <div className={demoStyles.appBar}>
            <span className={demoStyles.appLogo}>
              <BrandMark size={18} darkSurface />
              EQUINOX
            </span>
            <span className={demoStyles.appNav}>
              {TABS.map((t) => <span key={t.id} data-active={activeTab === t.id}>{t.label}</span>)}
            </span>
            <span className={demoStyles.appBarRight}>
              <span className={demoStyles.portfolioChip}><span className={demoStyles.chipLabel}>{demo.symbol}</span>{demo.price === null ? "—" : `$${fmt(demo.price)}`}</span>
              <Link href="/trade" className={demoStyles.launchBtn}>Launch</Link>
              <span className={demoStyles.avatar} aria-hidden />
            </span>
          </div>
          <div className={demoStyles.demoNote}>illustrative demo · live Pyth prices &amp; real sizing math · sample data tagged · devnet test USDC</div>
          <div className={demoStyles.screens}>
            <div key={activeTab} className={demoStyles.screen}>
              {activeTab === "trade" && <TradeScreen data={demo} active={revealed} />}
              {activeTab === "markets" && <MarketsScreen markets={markets} />}
              {activeTab === "portfolio" && <PortfolioScreen price={demo.price} />}
              {activeTab === "activity" && <ActivityScreen activity={activity} real={realActivity} />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
