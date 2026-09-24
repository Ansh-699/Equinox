"use client";
/* eslint-disable @next/next/no-img-element -- static brand marks */

// Marketing landing (Onyx design): sky-gradient hero, glass credibility pill,
// one glass CTA, and the dark app panel that floats up over the fold. Every
// number that claims to be live is read from chain / the market API; anything
// illustrative is tagged in the panel.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEMO_ORACLE_SNAPSHOT, DEMO_PROGRAM_ID, publicMarketApiUrl, publicV3Core } from "@/lib/demo-config";
import { PERP_MARKETS } from "@/lib/markets";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import { useMarketClock } from "@/features/oracle/use-market-clock";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { RESOLUTIONS, useCandles } from "@/features/trading/use-candles";
import { tradesFrom } from "@/features/trading/use-v3-book";
import { ThemeToggle } from "@/components/theme-toggle";
import { BrandMark } from "@/components/ui/brand-mark";
import { Reveal } from "@/components/reveal";
import { LandingHero, type ActivityRow, type PreviewMarket } from "./landing-hero";
import styles from "./landing.module.css";
import { fetchV3Aggregate } from "@/lib/v3-aggregate";

const LIVE_SYMBOL = PERP_MARKETS.find((m) => m.live)?.symbol ?? "TSLA-PERP";
const HOURLY = RESOLUTIONS.find((r) => r.code === "60") ?? RESOLUTIONS[3];

const FEATURES = [
  { title: "Matched in a MagicBlock rollup", body: "The order book is delegated to a MagicBlock Ephemeral Rollup, so orders place, cancel and fill in milliseconds, then commit back to Solana." },
  { title: "Priced by Pyth, verified on Solana", body: "Every fill and withdrawal is checked against a Pyth-signed price verified on Solana L1, with a ten-second freshness rule, confidence and market-session checks." },
  { title: "Collateral never leaves L1", body: "USDC sits in the program vault on Solana. The rollup only holds the book and positions while it trades, and the vault reconciles to the lamport on return." },
] as const;

function sampleActivity(price: number): ActivityRow[] {
  const now = Date.now();
  const rows: [ActivityRow["side"], ActivityRow["role"], number, number, number][] = [
    ["long", "Taker", 4, 0.999, 1], ["short", "Maker", 2, 1.002, 4], ["long", "Maker", 10, 0.997, 11],
    ["short", "Taker", 3, 1.001, 26], ["long", "Taker", 1, 0.995, 58], ["short", "Maker", 6, 1.004, 84],
  ];
  return rows.map(([side, role, size, k, mins]) => ({ side, role, size, price: price * k, t: now - mins * 60_000 }));
}

export function LandingView() {
  const rpc = useMemo(() => new SolanaRpcTransport(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet"), []);
  const clock = useMarketClock(DEMO_ORACLE_SNAPSHOT ? rpc : null, publicV3Core || null, DEMO_ORACLE_SNAPSHOT);
  const live = clock?.oracle ? { price: clock.oracle.price, publishTime: Number(clock.lastVerifiedOracleTimestamp) } : null;
  const { candles } = useCandles(publicMarketApiUrl, LIVE_SYMBOL, HOURLY, live);
  const execution = useExecutionStatus(publicMarketApiUrl, LIVE_SYMBOL);
  const [fills, setFills] = useState<ActivityRow[]>([]);

  // One read of the market's event shards for the Activity preview.
  useEffect(() => {
    if (!publicV3Core) return;
    void fetchV3Aggregate(publicV3Core)
      .then((data) => data as { eventShards?: Parameters<typeof tradesFrom>[0] } | null)
      .then((data) => {
        if (!data) return;
        setFills(tradesFrom(data.eventShards).map((t, i) => ({ side: i % 2 ? "short" : "long", role: "Taker", size: t.size, price: t.price, t: t.time * 1000 })));
      })
      .catch(() => undefined);
  }, []);

  const week = candles.slice(-24 * 7);
  const price = clock?.oracle?.price ?? week.at(-1)?.c ?? null;
  const day = candles.slice(-24);
  const changePct = day.length >= 2 && day[0].o > 0 ? ((day[day.length - 1].c - day[0].o) / day[0].o) * 100 : null;
  const liveMarket = PERP_MARKETS.find((m) => m.symbol === LIVE_SYMBOL);
  const markets: PreviewMarket[] = PERP_MARKETS.map((m) => ({ symbol: m.symbol, name: m.displayName, live: m.live, price: m.live ? price : null, changePct: m.live ? changePct : null }))
    .sort((a, b) => Number(b.live) - Number(a.live));

  return (
    <div className={styles.bleed}>
      <div className={styles.announce}>
        Now live on Solana devnet · TSLA-PERP ·{" "}
        <a href="https://github.com/Ansh-699" target="_blank" rel="noopener noreferrer">Github</a>
        <span style={{ position: "absolute", right: 12, top: 2 }}><ThemeToggle className="!h-6 !w-6 !text-[#123c66] hover:!bg-white/40" /></span>
      </div>

      <div className={styles.skyZone}>
        <LandingHero
          demo={{ symbol: LIVE_SYMBOL, name: liveMarket?.displayName ?? "Tesla", price, candles: week, maxLeverage: liveMarket?.maximumLeverage ?? 5, initialMarginBps: liveMarket?.initialMarginBps ?? 2_000 }}
          markets={markets}
          activity={fills.length ? fills : sampleActivity(price ?? 250)}
          realActivity={fills.length > 0}
        />
      </div>

      <div className={styles.lower}>
        <Reveal>
          <section className={styles.featureRow}>
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.featureCard}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </section>
        </Reveal>

        <Reveal>
          <section className={styles.marketsStrip}>
            <h2 className={styles.stripTitle}>Live on devnet right now</h2>
            <div className={styles.stripGrid}>
              <Link href="/trade" className={styles.previewCard}>
                <span className={styles.previewFixture}>{liveMarket?.displayName ?? "Tesla"} · perpetual</span>
                <span className={styles.previewTitle}>{LIVE_SYMBOL}</span>
                <span className={styles.previewPrices}>
                  <span className={styles.pYes}>{price === null ? "—" : `$${price.toFixed(2)}`}</span>
                  {changePct !== null && <span className={changePct >= 0 ? styles.pYes : styles.pNo}>{changePct >= 0 ? "+" : "−"}{Math.abs(changePct).toFixed(2)}% 24h</span>}
                </span>
                <span className={styles.previewVol}>Pyth confidence {clock?.oracle ? `± ${clock.oracle.confidence.toFixed(3)}` : "—"} · session {clock?.oracle ? (clock.oracle.tradingOpen ? "open" : "closed") : "—"}</span>
              </Link>
              <div className={styles.previewCard}>
                <span className={styles.previewFixture}>Execution</span>
                <span className={styles.previewTitle}>{execution ? (execution.marketDelegated ? "MagicBlock Ephemeral Rollup" : "Solana L1") : "—"}</span>
                <span className={styles.previewVol}>{execution ? (execution.marketDelegated ? "order book delegated · matching in the rollup" : "book on L1 · seats and deposits open") : "status loading"}</span>
              </div>
              <div className={styles.previewCard}>
                <span className={styles.previewFixture}>Finality</span>
                <span className={styles.previewTitle}>Commit #{execution?.lastCommittedL1Sequence ?? "—"}</span>
                <span className={styles.previewVol}>last rollup state committed back to Solana</span>
              </div>
            </div>
            <div className={styles.stripStats}>
              <span><strong>{PERP_MARKETS.filter((m) => m.live).length}</strong> market live</span>
              <span><strong>27</strong> accounts delegated per market</span>
              <span><strong>10s</strong> oracle freshness rule</span>
            </div>
          </section>
        </Reveal>
      </div>

      <footer className={styles.mega}>
        <div className={styles.megaInner}>
          <div className={styles.megaBrand}>
            <BrandMark size={30} darkSurface />
            EQUINOX
          </div>
          <div className={styles.megaCols}>
            <div>
              <span className={styles.megaColTitle}>Socials</span>
              <a href="https://github.com/Ansh-699" target="_blank" rel="noopener noreferrer">Github</a>
            </div>
            <div>
              <span className={styles.megaColTitle}>Quick links</span>
              <Link href="/trade">Trade</Link>
              <Link href="/portfolio">Portfolio</Link>
              <Link href="/activity">Activity</Link>
              <Link href="/settings">Settings</Link>
            </div>
            <div>
              <span className={styles.megaColTitle}>Protocol</span>
              <Link href="/diagnostics">Live deployment</Link>
              <a href={`https://explorer.solana.com/address/${DEMO_PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noopener noreferrer">Program on Explorer</a>
              {publicV3Core ? <a href={`https://explorer.solana.com/address/${publicV3Core}?cluster=devnet`} target="_blank" rel="noopener noreferrer">Market on Explorer</a> : null}
            </div>
            <div>
              <span className={styles.megaColTitle}>Resources</span>
              <a href="https://www.magicblock.gg" target="_blank" rel="noopener noreferrer">MagicBlock</a>
              <a href="https://www.pyth.network" target="_blank" rel="noopener noreferrer">Pyth Network</a>
              <a href="https://solana.com" target="_blank" rel="noopener noreferrer">Solana</a>
            </div>
          </div>
          <div className={styles.megaRule} />
          <p className={styles.megaCopy}>
            © 2026 Equinox. Devnet build — test USDC, not real funds. The rollup operator orders and matches trades; it cannot move collateral or settle against a price it chose.
          </p>
        </div>
        <div className={styles.megaMark} aria-hidden>
          <span className={styles.megaMarkText}>EQUINOX</span>
        </div>
      </footer>
    </div>
  );
}
