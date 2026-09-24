"use client";
/* eslint-disable @next/next/no-img-element -- issuer logos from their own CDN */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { V3_MARKETS } from "@/lib/v3-markets";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { tradingKeySigner } from "@/lib/trading-key";
import { claimTestFunds } from "@/lib/faucet-client";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";
import deployment from "@/config/equinox-deployment.json";
import { rollupExplorer } from "@/features/trading/er-tx-panel";
import { BASKETS, planBasket, tradeBasket, type LegPlan, type LegResult } from "./basket";

interface PreIpoToken {
  issuer: "PreStocks";
  name: string;
  symbol: string;
  mint: string;
  markPrice: number;
  tokenPrice: number | null;
  markValuation: number | null;
  image: string | null;
  url: string | null;
}

interface MarketLive { lastPrice?: number | null; reporter?: { markPrice?: number; tokenPrice?: number; premiumPct?: number; lastPostedAt?: number } | null }

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 4 : 2 });
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const pct = (p: number | null | undefined) => (p == null ? "—" : `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`);
const tone = (p: number | null | undefined) => (p == null ? "text-[var(--t-text-3)]" : p >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]");
const TH = "px-3 py-2 text-left text-[11px] font-normal text-[var(--t-text-3)]";
const TD = "tnum px-3 py-2 text-[12.5px] text-[var(--t-text)]";
const PERPS = V3_MARKETS.filter((market) => market.kind === "pre-ipo");
const perpFor = (token: string) => PERPS.find((market) => market.oracle.token === token);
const MM_STATUS_URL = process.env.NEXT_PUBLIC_MM_STATUS_URL;

/** Token premium (+) or discount (−) to the issuer's mark of the private company. */
export function premium(token: Pick<PreIpoToken, "markPrice" | "tokenPrice">): number | null {
  return token.tokenPrice === null || token.markPrice <= 0 ? null : ((token.tokenPrice - token.markPrice) / token.markPrice) * 100;
}

/** PreStocks pre-IPO companies: leveraged perps on Equinox (priced on-chain
 * from PreStocks), one-click baskets, and every PreStocks token with its
 * premium or discount to the company mark. */
export function PreIpoView() {
  const auth = useAppAuth();
  const [tokens, setTokens] = useState<PreIpoToken[] | null>(null);
  const [error, setError] = useState<string | null>(publicMarketApiUrl ? null : "Market API not configured.");
  const [live, setLive] = useState<Record<string, MarketLive>>({});

  useEffect(() => {
    if (!publicMarketApiUrl) return;
    fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/pre-ipo`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { tokens: PreIpoToken[] }) => setTokens(body.tokens.filter((t) => t.issuer === "PreStocks")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Live perp prices and the reporter's view of PreStocks, from the market-maker service.
  useEffect(() => {
    if (!MM_STATUS_URL) return;
    const read = () => void fetch(MM_STATUS_URL).then((r) => r.json()).then((s: { markets?: Record<string, MarketLive> }) => setLive(s.markets ?? {})).catch(() => undefined);
    read();
    const timer = setInterval(read, 3_000);
    return () => clearInterval(timer);
  }, []);

  const rows = (tokens ?? []).sort((a, b) => (b.markValuation ?? 0) - (a.markValuation ?? 0));
  const total = rows.reduce((sum, t) => sum + (t.markValuation ?? 0), 0);

  return (
    <div className="terminal min-h-screen">
      <TopBar active="pre-ipo" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">Pre-IPO · PreStocks</p>
        <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-[var(--t-text)]">Go long or short private companies</h1>
        <p className="mt-1 max-w-[76ch] text-[13px] text-[var(--t-text-2)]">
          Perpetuals on PreStocks pre-IPO tokens, up to 5×, in the MagicBlock rollup. Each market&apos;s price is the PreStocks token&apos;s on-chain price, posted to Solana every few seconds by a bounded reporter (at most 0.5% + 0.1%/s per update), so shorting or leveraging a private company tracks the token PreStocks holders trade.
        </p>

        <section aria-label="Pre-IPO perpetuals" className="mt-5 grid gap-3 md:grid-cols-3">
          {PERPS.map((market) => {
            const status = live[market.symbol];
            const reporter = status?.reporter;
            const token = rows.find((t) => t.symbol === market.oracle.token);
            return (
              <div key={market.symbol} className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
                <div className="flex items-center gap-2">
                  {token?.image ? <img src={token.image} alt="" className="h-6 w-6 rounded-full" /> : null}
                  <span className="text-[14px] font-semibold text-[var(--t-text)]">{market.symbol}</span>
                  <span className="ml-auto rounded bg-[var(--t-surface-3)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--t-text)]">PRE-IPO</span>
                </div>
                <div className="tnum mt-3 text-[22px] font-semibold text-[var(--t-text)]">{status?.lastPrice ? usd(status.lastPrice) : "—"}</div>
                <dl className="tnum mt-2 grid grid-cols-2 gap-y-1 text-[12px]">
                  <dt className="text-[var(--t-text-3)]">PreStocks mark</dt><dd className="text-right">{reporter?.markPrice ? usd(reporter.markPrice) : "—"}</dd>
                  <dt className="text-[var(--t-text-3)]">Token on-chain</dt><dd className="text-right">{reporter?.tokenPrice ? usd(reporter.tokenPrice) : "—"}</dd>
                  <dt className="text-[var(--t-text-3)]">Token vs mark</dt><dd className={`text-right ${tone(reporter?.premiumPct)}`}>{pct(reporter?.premiumPct)}</dd>
                </dl>
                <div className="mt-3 flex gap-2">
                  <Link href={`/trade?market=${market.symbol}`} className="flex-1 rounded-[6px] bg-[var(--t-up-3)] px-3 py-2 text-center text-[13px] font-semibold text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]">Trade</Link>
                  {token?.url ? <a href={token.url} target="_blank" rel="noopener noreferrer" className="rounded-[6px] border border-[var(--t-border)] px-3 py-2 text-[13px] text-[var(--t-text-2)] hover:text-[var(--t-text)]">PreStocks ↗</a> : null}
                </div>
              </div>
            );
          })}
        </section>

        <BasketPanel />

        <h2 className="mt-8 text-[15px] font-semibold text-[var(--t-text)]">Every PreStocks token</h2>
        <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-[var(--t-border)] bg-[var(--t-border)] md:grid-cols-3">
          {[["Tokens", tokens ? String(rows.length) : "—"], ["Combined mark valuation", tokens ? `$${compact(total)}` : "—"], ["Source", "PreStocks API · refreshed every 60 s"]].map(([k, v]) => (
            <div key={k} className="bg-[var(--t-bg)] px-4 py-3"><div className="text-[10.5px] text-[var(--t-text-3)]">{k}</div><div className="tnum mt-1 text-[14px] font-medium text-[var(--t-text)]">{v}</div></div>
          ))}
        </div>
        <div className="mt-3 overflow-x-auto rounded-[8px] border border-[var(--t-border)]">
          <table className="w-full min-w-[760px] border-collapse">
            <thead className="bg-[var(--t-surface)]"><tr>
              <th className={TH}>Company</th><th className={`${TH} text-right`}>Mark</th><th className={`${TH} text-right`}>Token</th>
              <th className={`${TH} text-right`}>Token vs mark</th><th className={`${TH} text-right`}>Valuation</th><th className={TH}>Trade</th>
            </tr></thead>
            <tbody>
              {!tokens && !error ? <tr><td colSpan={6} className="px-3 py-8 text-center text-[12px] text-[var(--t-text-2)]">Loading PreStocks prices…</td></tr> : null}
              {error ? <tr><td colSpan={6} className="px-3 py-8 text-center text-[12px] text-[var(--t-down)]">Couldn&apos;t load PreStocks prices: {error}</td></tr> : null}
              {rows.map((t) => {
                const p = premium(t);
                const perp = perpFor(t.symbol);
                return (
                  <tr key={t.mint} className="border-t border-[var(--t-surface-2)] hover:bg-[var(--t-surface)]">
                    <td className={TD}>
                      <span className="flex items-center gap-2">
                        {t.image ? <img src={t.image} alt="" className="h-5 w-5 rounded-full" /> : null}
                        <span className="font-medium">{t.name.replace(/ PreStocks$/, "")}</span>
                      </span>
                    </td>
                    <td className={`${TD} text-right`}>{usd(t.markPrice)}</td>
                    <td className={`${TD} text-right`}>{t.tokenPrice === null ? "—" : usd(t.tokenPrice)}</td>
                    <td className={`${TD} text-right ${tone(p)}`}>{pct(p)}</td>
                    <td className={`${TD} text-right`}>{t.markValuation ? `$${compact(t.markValuation)}` : "—"}</td>
                    <td className={TD}>
                      <span className="flex gap-3 text-[12px]">
                        {perp ? <Link className="font-medium text-[var(--t-up)] hover:underline" href={`/trade?market=${perp.symbol}`}>Trade perp</Link> : null}
                        <a className="text-[var(--t-link)] hover:underline" href={`https://jup.ag/swap/USDC-${t.mint}`} target="_blank" rel="noopener noreferrer">Swap token</a>
                        {t.url ? <a className="text-[var(--t-text-2)] hover:underline" href={t.url} target="_blank" rel="noopener noreferrer">PreStocks</a> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11.5px] text-[var(--t-text-3)]">Perps run on Solana devnet with test USDC. PreStocks tokens themselves trade on Solana mainnet (Swap opens Jupiter). The mark is PreStocks&apos; reference price for the private company; the perp tracks the token.</p>
      </main>
    </div>
  );
}

/** One click: long or short a basket of pre-IPO perps. The only wallet prompt is
 * the one-time trading-key signature; seats, margin and orders are signed by it. */
function BasketPanel() {
  const auth = useAppAuth();
  const tradingKey = useTradingKey(auth);
  const [basketId, setBasketId] = useState(BASKETS[0].id);
  const [side, setSide] = useState<"long" | "short">("long");
  // Pre-IPO shares cost $100s-$1,000s: a basket buys at least one share per leg.
  const [amount, setAmount] = useState("3000");
  const [leverage, setLeverage] = useState(5);
  const [plan, setPlan] = useState<LegPlan[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; legs: LegResult[]; message?: string; ms?: number } | null>(null);
  const basket = BASKETS.find((b) => b.id === basketId) ?? BASKETS[0];
  const notional = Number(amount);
  const rpc = useMemo(() => new SolanaRpcTransport(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet"), []);
  // The real legs (whole shares) and their margin, shown before anything trades.
  useEffect(() => {
    if (!(notional > 0)) return;
    let stopped = false;
    void planBasket(basket, notional, leverage, rpc).then((legs) => { if (!stopped) setPlan(legs); }).catch(() => undefined);
    return () => { stopped = true; };
  }, [basket, notional, leverage, rpc]);
  const marginUsd = plan?.reduce((sum, leg) => sum + leg.marginUsd, 0) ?? null;

  async function run() {
    if (!auth.walletAddress) { setResult({ ok: false, legs: [], message: "Connect a wallet first (top right)." }); return; }
    if (!(notional > 0)) return;
    setResult(null);
    const started = performance.now();
    try {
      setProgress("Unlocking your trading account…");
      // The one wallet prompt (first time on this device): the rest is signed by the trading key.
      const signer = tradingKey.signer ?? tradingKeySigner(await tradingKey.unlock());
      // Priced now (not from the preview), then funded: every leg's margin comes from the trading account.
      const legs = await planBasket(basket, notional, leverage, rpc);
      const needed = BigInt(Math.ceil(legs.reduce((sum, leg) => sum + leg.marginUsd, 0) * 1e6));
      const ata = deriveCollateralTokenAccount(signer.address!, deployment.collateralMint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const balance = () => rpc.tokenBalance(String(ata)).catch(() => 0n);
      if ((await balance()) < needed) {
        setProgress("Funding your trading account with test USDC…");
        const message = await claimTestFunds({ privyAuthenticated: false, getAccessToken: async () => null, signMessage: (_a: string, bytes: Uint8Array) => signer.signMessage(bytes) }, signer.address!);
        // Wait until the faucet's USDC is visible before any leg deposits it.
        for (let attempt = 0; attempt < 30 && (await balance()) < needed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
        if ((await balance()) < needed) throw new Error(`${message} This basket needs $${(Number(needed) / 1e6).toFixed(0)} margin: lower the size or raise the leverage.`);
      }
      const filled = await tradeBasket(legs, side, leverage, signer, setProgress);
      setResult({ ok: true, legs: filled, ms: Math.round(performance.now() - started) });
    } catch (error) {
      setResult({ ok: false, legs: [], message: error instanceof Error ? error.message : String(error) });
    } finally {
      setProgress(null);
    }
  }

  return (
    <section aria-label="Pre-IPO baskets" className="mt-6 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--t-text)]">Baskets · one click, every leg</h2>
        <span className="text-[11.5px] text-[var(--t-text-3)]">Each leg is a market order in its own perp; margin is isolated per market.</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div className="grid gap-2 sm:grid-cols-2">
          {BASKETS.map((b) => (
            <button key={b.id} type="button" aria-pressed={b.id === basketId} onClick={() => setBasketId(b.id)}
              className={`rounded-[6px] border px-3 py-2 text-left ${b.id === basketId ? "border-[var(--t-up)] bg-[var(--t-bg)]" : "border-[var(--t-border)] hover:bg-[var(--t-bg)]"}`}>
              <div className="text-[13px] font-semibold text-[var(--t-text)]">{b.name}</div>
              <div className="text-[11.5px] text-[var(--t-text-2)]">{b.blurb}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Direction" className="flex gap-1">
            {(["long", "short"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                className={`h-[34px] rounded-[6px] px-3 text-[13px] font-medium ${side === s ? (s === "long" ? "bg-[var(--t-up-3)] text-[var(--t-on-fill)]" : "bg-[var(--t-down-3)] text-[var(--t-on-fill)]") : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>{s === "long" ? "Long" : "Short"}</button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[12px] text-[var(--t-text-2)]">Size $
            <input aria-label="Basket size in USD" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tnum h-[34px] w-[90px] rounded-[6px] border border-[var(--t-border)] bg-[var(--t-bg)] px-2 text-[13px] text-[var(--t-text)]" />
          </label>
          <label className="flex items-center gap-1 text-[12px] text-[var(--t-text-2)]">Leverage
            <select aria-label="Leverage" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="h-[34px] rounded-[6px] border border-[var(--t-border)] bg-[var(--t-bg)] px-2 text-[13px] text-[var(--t-text)]">
              {[1, 2, 3, 5].map((l) => <option key={l} value={l}>{l}×</option>)}
            </select>
          </label>
        </div>
        <button type="button" onClick={() => void run()} disabled={!!progress || !(notional > 0)}
          className={`h-[40px] rounded-[6px] px-4 text-[14px] font-semibold ${progress ? "bg-[var(--t-surface-3)] text-[var(--t-text-2)]" : side === "long" ? "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]" : "bg-[var(--t-down-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-down-2)]"}`}>
          {progress ?? `${side === "long" ? "Buy" : "Short"} ${basket.name} · $${Number.isFinite(notional) ? notional.toLocaleString() : "—"}`}
        </button>
      </div>
      {plan ? (
        <p className="tnum mt-2 text-[12px] text-[var(--t-text-2)]">
          {plan.map((leg) => `${leg.market.symbol.replace("-PERP", "")} ${leg.quantity} × ~${usd(leg.price)}`).join(" · ")} · margin ≈ {marginUsd === null ? "—" : usd(marginUsd)}
        </p>
      ) : null}
      {result ? (
        <div role="status" className={`mt-3 rounded-[6px] border px-3 py-2 text-[12.5px] ${result.ok ? "border-[var(--t-border)]" : "border-[var(--t-down)] text-[var(--t-down)]"}`}>
          {result.ok ? (
            <>
              <div className="text-[var(--t-text)]">{basket.name} {side === "long" ? "bought" : "shorted"} · {result.legs.length} legs · {result.ms} ms total</div>
              <ul className="tnum mt-1 space-y-0.5 text-[var(--t-text-2)]">
                {result.legs.map((leg) => (
                  <li key={leg.symbol} className="flex gap-3">
                    <span className="w-[130px] text-[var(--t-text)]">{leg.symbol}</span>
                    <span>{side === "long" ? "+" : "−"}{leg.quantity.toString()} @ ~{usd(leg.price)}</span>
                    <span>order {leg.ms} ms</span>
                    {leg.signature ? <a className="text-[var(--t-link)] hover:underline" href={rollupExplorer(leg.signature)} target="_blank" rel="noreferrer">View ↗</a> : null}
                  </li>
                ))}
              </ul>
              <Link href={`/trade?market=${result.legs[0]?.symbol ?? ""}`} className="mt-1 inline-block text-[var(--t-link)] hover:underline">See positions in the terminal</Link>
            </>
          ) : result.message}
        </div>
      ) : null}
    </section>
  );
}
