"use client";
/* eslint-disable @next/next/no-img-element -- static brand marks, no optimisation needed */

// Landing hero (Onyx design): wordmark, credibility pill, headline, one CTA,
// then the floating app window (app-preview.tsx) rising over the fold.

import { BrandMark } from "@/components/ui/brand-mark";
import { AppPreview, type PerpDemoData } from "./app-preview";
import { ChromeCta } from "./chrome-cta";
import styles from "./landing.module.css";

const SPONSORS = [["MagicBlock", "/landing/magicblock.jpg"], ["PreStocks", "/landing/prestocks.png"], ["Meteora", "/landing/meteora.svg"]] as const;

export function LandingHero({ demo }: { demo: PerpDemoData }) {
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
      </section>

      <section className={styles.panelZone}>
        <AppPreview demo={demo} />
      </section>
    </div>
  );
}
