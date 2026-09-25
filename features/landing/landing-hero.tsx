"use client";
/* eslint-disable @next/next/no-img-element -- static brand marks, no optimisation needed */

// Landing hero (Onyx design): wordmark, credibility pill, headline, one CTA,
// then the floating app window (app-preview.tsx) rising over the fold.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { AppPreview, PREVIEW_TABS, type PerpDemoData, type TabId } from "./app-preview";
import { ChromeCta } from "./chrome-cta";
import styles from "./landing.module.css";

const SPONSORS = [["MagicBlock", "/landing/magicblock.jpg"], ["PreStocks", "/landing/prestocks.png"], ["Meteora", "/landing/meteora.svg"]] as const;

export function LandingHero({ demo }: { demo: PerpDemoData }) {
  const [tab, setTab] = useState<TabId>("trade");
  const [touring, setTouring] = useState(true);
  const stopTour = useCallback(() => setTouring(false), []);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

  // Sliding white chip: glide the indicator to the active tab (transform + width only).
  useEffect(() => {
    const measure = () => {
      const el = tabRefs.current[PREVIEW_TABS.findIndex((t) => t.id === tab)];
      if (el) setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [tab]);

  const choose = (id: TabId) => { setTouring(false); setTab(id); };
  function onTabKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = PREVIEW_TABS.findIndex((t) => t.id === tab);
    const next = (idx + (e.key === "ArrowRight" ? 1 : PREVIEW_TABS.length - 1)) % PREVIEW_TABS.length;
    choose(PREVIEW_TABS[next].id);
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
              <span className={styles.credItem}>
                Built on
                <span className={styles.sponsors}>
                  <span className={styles.sponsor} data-name="Solana" role="img" aria-label="Solana">
                    <img src="/landing/Solana-Round-Logo-PNG.png" alt="" width={20} height={20} />
                  </span>
                </span>
              </span>
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
            {PREVIEW_TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[i] = el; }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="preview-screen"
                tabIndex={tab === t.id ? 0 : -1}
                data-primary={tab === t.id}
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.panelZone}>
        <AppPreview demo={demo} tab={tab} setTab={setTab} touring={touring} stopTour={stopTour} />
      </section>
    </div>
  );
}
