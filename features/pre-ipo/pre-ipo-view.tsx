"use client";
/* eslint-disable @next/next/no-img-element -- issuer logos from their own CDN */

import { useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { publicMarketApiUrl } from "@/lib/demo-config";

interface PreIpoToken {
  issuer: "PreStocks" | "Tessera";
  name: string;
  symbol: string;
  mint: string;
  markPrice: number;
  tokenPrice: number | null;
  markValuation: number | null;
  sector: string | null;
  image: string | null;
  url: string | null;
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 4 : 2 });
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const TH = "px-3 py-2 text-left text-[11px] font-normal text-[var(--t-text-3)]";
const TD = "tnum px-3 py-2 text-[12.5px] text-[var(--t-text)]";

/** Token premium (+) or discount (−) to the issuer's mark of the private company. */
export function premium(token: Pick<PreIpoToken, "markPrice" | "tokenPrice">): number | null {
  return token.tokenPrice === null || token.markPrice <= 0 ? null : ((token.tokenPrice - token.markPrice) / token.markPrice) * 100;
}

/** Pre-IPO tokens on Solana (PreStocks, Tessera): where each token trades
 * against its issuer's mark, and one click to trade it on Solana. */
export function PreIpoView() {
  const auth = useAppAuth();
  const [tokens, setTokens] = useState<PreIpoToken[] | null>(null);
  const [error, setError] = useState<string | null>(publicMarketApiUrl ? null : "Market API not configured.");
  const [issuer, setIssuer] = useState<"all" | PreIpoToken["issuer"]>("all");

  useEffect(() => {
    if (!publicMarketApiUrl) return;
    fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/pre-ipo`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { tokens: PreIpoToken[] }) => setTokens(body.tokens))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = (tokens ?? []).filter((t) => issuer === "all" || t.issuer === issuer).sort((a, b) => (b.markValuation ?? 0) - (a.markValuation ?? 0));
  const total = rows.reduce((sum, t) => sum + (t.markValuation ?? 0), 0);

  return (
    <div className="terminal min-h-screen">
      <TopBar active="pre-ipo" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">Pre-IPO · PreStocks &amp; Tessera</p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-[var(--t-text)]">Private companies, tradable on Solana</h1>
            <p className="mt-1 max-w-[70ch] text-[13px] text-[var(--t-text-2)]">Live issuer marks for tokenized pre-IPO exposure, with the on-chain token price where the issuer publishes one, so a premium or discount to the mark is visible at a glance.</p>
          </div>
          <div role="group" aria-label="Issuer" className="flex gap-1">
            {(["all", "PreStocks", "Tessera"] as const).map((id) => (
              <button key={id} type="button" aria-pressed={issuer === id} onClick={() => setIssuer(id)} className={`h-[28px] rounded-[4px] px-3 text-[12px] ${issuer === id ? "bg-[var(--t-surface-3)] text-[var(--t-text)]" : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>{id === "all" ? "All" : id}</button>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-[var(--t-border)] bg-[var(--t-border)] md:grid-cols-3">
          {[["Tokens", tokens ? String(rows.length) : "—"], ["Combined mark valuation", tokens ? `$${compact(total)}` : "—"], ["Source", "issuer APIs · refreshed every 60 s"]].map(([k, v]) => (
            <div key={k} className="bg-[var(--t-bg)] px-4 py-3"><div className="text-[10.5px] text-[var(--t-text-3)]">{k}</div><div className="tnum mt-1 text-[14px] font-medium text-[var(--t-text)]">{v}</div></div>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto rounded-[8px] border border-[var(--t-border)]">
          <table className="w-full min-w-[760px] border-collapse">
            <thead className="bg-[var(--t-surface)]"><tr>
              <th className={TH}>Company</th><th className={TH}>Issuer</th><th className={`${TH} text-right`}>Mark</th><th className={`${TH} text-right`}>Token</th>
              <th className={`${TH} text-right`}>Premium</th><th className={`${TH} text-right`}>Valuation</th><th className={TH}>Trade</th>
            </tr></thead>
            <tbody>
              {!tokens && !error ? <tr><td colSpan={7} className="px-3 py-8 text-center text-[12px] text-[var(--t-text-2)]">Loading issuer prices…</td></tr> : null}
              {error ? <tr><td colSpan={7} className="px-3 py-8 text-center text-[12px] text-[var(--t-down)]">Couldn&apos;t load pre-IPO prices: {error}</td></tr> : null}
              {rows.map((t) => {
                const p = premium(t);
                return (
                  <tr key={t.mint} className="border-t border-[var(--t-surface-2)] hover:bg-[var(--t-surface)]">
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        {t.image ? <img src={t.image} alt="" className="h-5 w-5 rounded-full" /> : <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--t-surface-3)] text-[10px] font-bold">{t.name.replace(/^T-/, "").slice(0, 1)}</span>}
                        <span className="font-medium">{t.name.replace(/ PreStocks$/, "")}</span>
                        {t.sector ? <span className="text-[11px] text-[var(--t-text-3)]">{t.sector}</span> : null}
                      </span>
                    </td>
                    <td className={`${TD} text-[var(--t-text-2)]`}>{t.issuer}</td>
                    <td className={`${TD} text-right`}>{usd(t.markPrice)}</td>
                    <td className={`${TD} text-right`}>{t.tokenPrice === null ? "—" : usd(t.tokenPrice)}</td>
                    <td className={`${TD} text-right ${p === null ? "text-[var(--t-text-3)]" : p >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{p === null ? "—" : `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`}</td>
                    <td className={`${TD} text-right`}>{t.markValuation ? `$${compact(t.markValuation)}` : "—"}</td>
                    <td className={TD}>
                      <span className="flex gap-3 text-[12px]">
                        <a className="text-[var(--t-link)] hover:underline" href={`https://jup.ag/swap/USDC-${t.mint}`} target="_blank" rel="noopener noreferrer">Swap</a>
                        {t.url ? <a className="text-[var(--t-link)] hover:underline" href={t.url} target="_blank" rel="noopener noreferrer">{t.issuer}</a> : null}
                        <a className="text-[var(--t-text-2)] hover:underline" href={`https://explorer.solana.com/address/${t.mint}`} target="_blank" rel="noopener noreferrer">Mint</a>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11.5px] text-[var(--t-text-3)]">Issuer marks are reference prices published by PreStocks and Tessera, shown for discovery only. StockStream never uses them for margin: perps here are priced only by Pyth, verified on Solana. Tokens trade on Solana mainnet.</p>
      </main>
    </div>
  );
}
