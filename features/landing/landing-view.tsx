"use client";

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
import { ThemeToggle } from "@/components/theme-toggle";
import { MarketIcon } from "@/components/ui/market-icon";
import { DOCS_URL } from "@/components/layout/top-bar";
import { MM_SERVICE_URL, V3_MARKETS, marketPair } from "@/lib/v3-markets";
import { BrandMark } from "@/components/ui/brand-mark";
import { Reveal } from "@/components/reveal";
import { LandingHero } from "./landing-hero";
import styles from "./landing.module.css";

const REPO_URL = "https://github.com/Ansh-699/Equinox";
const LIVE_SYMBOL = PERP_MARKETS.find((m) => m.live)?.symbol ?? "TSLA-PERP";
const HOURLY = RESOLUTIONS.find((r) => r.code === "60") ?? RESOLUTIONS[3];

const FEATURES = [
  { title: "Matched in a MagicBlock rollup", body: "The order book is delegated to a MagicBlock Ephemeral Rollup, so orders place, cancel and fill in milliseconds, then commit back to Solana." },
  { title: "Verified prices on Solana", body: "Stocks use Pyth-signed prices verified on Solana L1; pre-IPO markets use PreStocks token prices posted by a bounded reporter. Every fill checks a ten-second freshness rule." },
  { title: "Collateral never leaves L1", body: "USDC sits in the program vault on Solana. The rollup only holds the book and positions while it trades, and the vault reconciles to the lamport on return." },
] as const;

export function LandingView() {
  const rpc = useMemo(() => new SolanaRpcTransport(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet"), []);
  const clock = useMarketClock(DEMO_ORACLE_SNAPSHOT ? rpc : null, publicV3Core || null, DEMO_ORACLE_SNAPSHOT);
  const live = clock?.oracle ? { price: clock.oracle.price, publishTime: Number(clock.lastVerifiedOracleTimestamp) } : null;
  const { candles } = useCandles(publicMarketApiUrl, LIVE_SYMBOL, HOURLY, live);
  const execution = useExecutionStatus(publicMarketApiUrl, LIVE_SYMBOL);

  // Pre-IPO prices from the market-maker service (TSLA uses the verified Pyth price above).
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!MM_SERVICE_URL) return;
    const read = () => void fetch(`${MM_SERVICE_URL}/v1/mm/status`).then((r) => r.json())
      .then((s: { markets?: Record<string, { lastPrice?: number | null }> }) => setPrices(Object.fromEntries(Object.entries(s.markets ?? {}).flatMap(([k, v]) => (v.lastPrice ? [[k, v.lastPrice]] : [])))))
      .catch(() => undefined);
    read();
    const timer = setInterval(read, 15_000);
    return () => clearInterval(timer);
  }, []);
  const week = candles.slice(-24 * 7);
  const price = clock?.oracle?.price ?? week.at(-1)?.c ?? null;
  const liveMarket = PERP_MARKETS.find((m) => m.symbol === LIVE_SYMBOL);

  return (
    <div className={styles.bleed}>
      <div className={styles.announce}>
        Now live on Solana devnet ·{" "}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a> ·{" "}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        <span style={{ position: "absolute", right: 12, top: 2 }}><ThemeToggle className="!h-6 !w-6 !text-[#123c66] hover:!bg-white/40" /></span>
      </div>

      <div className={styles.skyZone}>
        <LandingHero
          demo={{ symbol: LIVE_SYMBOL, name: liveMarket?.displayName ?? "Tesla", price, candles: week, maxLeverage: liveMarket?.maximumLeverage ?? 5, initialMarginBps: liveMarket?.initialMarginBps ?? 2_000 }}
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
            <div className={styles.stripGridFour}>
              {V3_MARKETS.map((m) => {
                const live = m.symbol === LIVE_SYMBOL ? price : prices[m.symbol] ?? null;
                return (
                  <Link key={m.symbol} href={`/trade?market=${m.symbol}`} className={styles.previewCard}>
                    <span className={styles.marketHead}><MarketIcon symbol={m.symbol} size={26} /><span className={styles.previewTitle}>{marketPair(m.symbol)}</span></span>
                    <span className={styles.previewPrices}>
                      <span className={styles.pYes}>{live === null ? "—" : `$${live.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>
                    </span>
                    <span className={styles.previewVol}>{m.oracle.kind === "pyth" ? "Pyth · stock perp" : "PreStocks · pre-IPO perp"}</span>
                  </Link>
                );
              })}
            </div>
            <div className={styles.stripStats}>
              <span><strong>{V3_MARKETS.length}</strong> markets live</span>
              <span><strong>27</strong> accounts delegated per market</span>
              <span>commit <strong>#{execution?.lastCommittedL1Sequence ?? "—"}</strong> on Solana</span>
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
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
              <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
            </div>
            <div>
              <span className={styles.megaColTitle}>Quick links</span>
              <Link href="/trade">Trade</Link>
              <Link href="/pre-ipo">Pre-IPO</Link>
              <Link href="/launch">Launch</Link>
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
              <a href="https://prestocks.com" target="_blank" rel="noopener noreferrer">PreStocks</a>
              <a href="https://www.meteora.ag" target="_blank" rel="noopener noreferrer">Meteora</a>
            </div>
          </div>
          <div className={styles.megaRule} />
          <p className={styles.megaCopy}>
            © 2026 Equinox. Solana devnet.
          </p>
        </div>
        <div className={styles.megaMark} aria-hidden>
          <span className={styles.megaMarkText}>EQUINOX</span>
        </div>
      </footer>
    </div>
  );
}
