"use client";
/* eslint-disable @next/next/no-img-element -- static logos */

// The Architecture tab: the path an order takes (app → rollup → Solana),
// with the services that feed each step underneath. Deliberately quiet: one
// line per step, hairline links, a single dot travelling the path.

import css from "./preview.module.css";

interface Feed { logo: string; name: string; round?: boolean }
interface Stage { logo: string; title: string; line: string; feeds: Feed[]; feedsLabel?: string }

const STAGES: Stage[] = [
  { logo: "/brand/equinox-dark.png", title: "Equinox app", line: "Signed by your trading key", feeds: [] },
  { logo: "/landing/magicblock.jpg", title: "MagicBlock rollup", line: "Matches orders", feeds: [{ logo: "/brand/equinox-dark.png", name: "Market maker", round: true }], feedsLabel: "Quotes" },
  {
    logo: "/landing/Solana-Round-Logo-PNG.png", title: "Solana", line: "Holds USDC, settles", feedsLabel: "Prices & pools",
    feeds: [{ logo: "/landing/pyth.png", name: "Pyth" }, { logo: "/landing/prestocks.png", name: "PreStocks", round: true }, { logo: "/landing/meteora.svg", name: "Meteora" }],
  },
];
const LINKS = ["orders", "commits"];

export function ArchitectureScreen({ rate, blockMs }: { rate: number | null; blockMs: number | null }) {
  const live = [null, blockMs === null ? null : `${blockMs} ms blocks`, null];
  return (
    <div className={`${css.pad} ${css.archPad}`}>
      <div className={css.screenHead}>
        <div><h3>How it works</h3><p className={css.muted}>Trades match in the rollup; USDC never leaves Solana.</p></div>
        {rate !== null && <span className={`${css.chip} tnum`}><span className={css.dot} aria-hidden />{rate.toFixed(1)} tx/s</span>}
      </div>

      <ol className={css.lane}>
        {STAGES.map((stage, i) => (
          <li key={stage.title} className={css.laneItem}>
            {i > 0 && (
              <span className={css.link} aria-hidden>
                <span className={css.linkLabel}>{LINKS[i - 1]}</span>
                <span className={css.linkDot} style={{ animationDelay: `${(i - 1) * 1.2}s` }} />
              </span>
            )}
            <div className={css.stage}>
              <div className={css.stageNode}>
                <img src={stage.logo} alt="" width={36} height={36} />
                <span>
                  <b>{stage.title}</b>
                  <span className={css.muted}>{stage.line}</span>
                  {live[i] && <span className={`${css.stageLive} tnum`}>{live[i]}</span>}
                </span>
              </div>
              {stage.feeds.length > 0 && (
                <div className={css.feeds}>
                  <span className={css.feedsLabel}>{stage.feedsLabel}</span>
                  <span className={css.feedChips}>
                    {stage.feeds.map((f) => (
                      <span key={f.name} className={css.feedChip}>
                        <img src={f.logo} alt="" width={16} height={16} data-round={f.round} />{f.name}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
