"use client";
/* eslint-disable @next/next/no-img-element -- issuer logos from their own CDN */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { marketPair, V3_MARKETS } from "@/lib/v3-markets";
import { MarketIcon } from "@/components/ui/market-icon";
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
const TH = "px-4 py-2.5 text-left text-[11px] font-medium text-[var(--t-text-3)]";
const TD = "tnum px-4 py-3 text-[12.5px] text-[var(--t-text)]";
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
          Perps on PreStocks pre-IPO tokens, up to 5×, matched in the MagicBlock rollup and settled in USDC.
        </p>
        <ol aria-label="How a pre-IPO perp is priced and traded" className="mt-4 grid gap-2 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["PreStocks token", "One token per company, traded on Solana."],
            ["Price feed", "Its price is posted on-chain every few seconds."],
            ["MagicBlock rollup", "Orders fill in milliseconds."],
            ["USDC settlement", "PnL settles in USDC; no token held."],
          ].map(([title, body], index) => (
            <li key={title} className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] p-3">
              <span className="text-[10.5px] font-semibold text-[var(--t-text-3)]">{index + 1} · {title}</span>
              <p className="mt-1 leading-snug text-[var(--t-text-2)]">{body}</p>
            </li>
          ))}
        </ol>

        <section aria-label="Pre-IPO perpetuals" className="mt-5 grid gap-3 md:grid-cols-3">
          {PERPS.map((market) => {
            const status = live[market.symbol];
            const reporter = status?.reporter;
            const token = rows.find((t) => t.symbol === market.oracle.token);
            return (
              <div key={market.symbol} className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
                <div className="flex items-center gap-2">
                  <MarketIcon symbol={market.symbol} size={26} />
                  <span className="flex flex-col leading-tight">
                    <span className="text-[14px] font-semibold text-[var(--t-text)]">{marketPair(market.symbol)} <span className="text-[10.5px] font-medium text-[var(--t-text-3)]">perp</span></span>
                    <span className="text-[11px] text-[var(--t-text-3)]">{market.name} · tracks {token?.symbol ?? market.oracle.token} (PreStocks)</span>
                  </span>
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

        <section aria-label="Every PreStocks token" className="mt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-semibold text-[var(--t-text)]">Every PreStocks token</h2>
            <span className="text-[12px] text-[var(--t-text-3)]">
              {tokens ? <><span className="tnum">{rows.length}</span> companies · <span className="tnum">${compact(total)}</span> combined valuation · refreshed every minute</> : "loading…"}
            </span>
          </div>
          <div className="relative mt-3 overflow-x-auto rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)]">
            <table className="w-full min-w-[760px] border-collapse">
              <thead><tr className="border-b border-[var(--t-border)]">
                <th className={TH}>Company</th><th className={`${TH} text-right`}>Mark</th><th className={`${TH} text-right`}>Token</th>
                <th className={`${TH} text-right`}>Token vs mark</th><th className={`${TH} text-right`}>Valuation</th><th className={`${TH} text-right`}><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {!tokens && !error ? <tr><td colSpan={6} className="px-4 py-10 text-center text-[12.5px] text-[var(--t-text-3)]">Loading PreStocks prices…</td></tr> : null}
                {error ? <tr><td colSpan={6} className="px-4 py-10 text-center text-[12.5px] text-[var(--t-down)]">Couldn&apos;t load PreStocks prices: {error}</td></tr> : null}
                {rows.map((t) => {
                  const p = premium(t);
                  const perp = perpFor(t.symbol);
                  return (
                    <tr key={t.mint} className="border-b border-[var(--t-border)] transition-colors last:border-0 hover:bg-[var(--t-surface-3)]/50">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-3">
                          {t.image ? <img src={t.image} alt="" className="h-7 w-7 rounded-full bg-white object-cover ring-1 ring-[var(--t-border)]" /> : <span className="h-7 w-7 rounded-full bg-[var(--t-surface-3)]" />}
                          <span className="text-[13.5px] font-medium text-[var(--t-text)]">{t.name.replace(/ PreStocks$/, "")}</span>
                          {perp ? <span className="rounded-[4px] bg-[var(--t-up)]/12 px-1.5 py-px text-[10.5px] font-medium text-[var(--t-up)]">perp live</span> : null}
                        </span>
                      </td>
                      <td className={`${TD} text-right`}>{usd(t.markPrice)}</td>
                      <td className={`${TD} text-right`}>{t.tokenPrice === null ? "—" : usd(t.tokenPrice)}</td>
                      <td className={`${TD} text-right`}>
                        <span className={`inline-block min-w-[62px] rounded-[5px] px-2 py-0.5 text-center text-[12px] ${p == null ? "text-[var(--t-text-3)]" : p >= 0 ? "bg-[var(--t-up)]/12 text-[var(--t-up)]" : "bg-[var(--t-down)]/12 text-[var(--t-down)]"}`}>{pct(p)}</span>
                      </td>
                      <td className={`${TD} text-right text-[var(--t-text-2)]`}>{t.markValuation ? `$${compact(t.markValuation)}` : "—"}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center justify-end gap-2 text-[12.5px]">
                          {perp ? <Link href={`/trade?market=${perp.symbol}`} className="rounded-[6px] bg-[var(--t-up-3)] px-3 py-1.5 font-medium text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]">Trade</Link> : null}
                          <a href={`https://jup.ag/swap/USDC-${t.mint}`} target="_blank" rel="noopener noreferrer" className="rounded-[6px] border border-[var(--t-border)] px-3 py-1.5 text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">Swap ↗</a>
                          {t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label={`${t.name} on PreStocks`} title="PreStocks" className="grid h-[30px] w-[30px] place-items-center rounded-[6px] text-[var(--t-text-3)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">↗</a> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2.5 text-[11.5px] text-[var(--t-text-3)]">Tokens trade on Solana mainnet (Swap opens Jupiter). Perps use devnet test USDC. The mark is PreStocks&apos; reference price for the company.</p>
        </section>
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

  const chip = (active: boolean) => `h-[32px] flex-1 rounded-[6px] border text-[12.5px] font-medium transition-colors ${active ? "border-[var(--t-text-2)] bg-[var(--t-surface-3)] text-[var(--t-text)]" : "border-[var(--t-border)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`;

  return (
    <section aria-label="Pre-IPO baskets" className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold text-[var(--t-text)]">Baskets</h2>
        <span className="text-[12px] text-[var(--t-text-3)]">Several companies in one click. Each leg is its own market order with isolated margin.</span>
      </div>
      <div className="mt-3 grid overflow-hidden rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)] md:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-2 p-4">
          {BASKETS.map((b) => {
            const active = b.id === basketId;
            return (
              <button key={b.id} type="button" aria-pressed={active} onClick={() => setBasketId(b.id)}
                className={`flex items-center gap-3 rounded-[8px] border px-3.5 py-3 text-left transition-colors ${active ? "border-[var(--t-accent)] bg-[var(--t-surface-3)]/60" : "border-[var(--t-border)] hover:bg-[var(--t-surface-3)]/40"}`}>
                <span className="flex shrink-0">
                  {b.legs.map((leg, index) => <span key={leg.symbol} className={index ? "-ml-2" : ""}><MarketIcon symbol={leg.symbol} size={28} /></span>)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-[var(--t-text)]">{b.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-1.5">
                    {b.legs.map((leg) => (
                      <span key={leg.symbol} className="tnum rounded-[4px] bg-[var(--t-surface-3)] px-1.5 py-px text-[11px] text-[var(--t-text-2)]">{leg.symbol.replace("-PERP", "")} {Math.round(leg.weight * 100)}%</span>
                    ))}
                  </span>
                </span>
                <span aria-hidden className={`h-4 w-4 shrink-0 rounded-full border ${active ? "border-[5px] border-[var(--t-accent)]" : "border-[var(--t-border-strong)]"}`} />
              </button>
            );
          })}
          <dl className="mt-auto grid grid-cols-3 gap-2 pt-3 text-[11.5px]">
            {[["Legs", "in parallel"], ["Margin", "isolated per market"], ["Wallet prompts", "one in total"]].map(([k, v]) => (
              <div key={k} className="rounded-[8px] border border-[var(--t-border)] px-3 py-2">
                <dt className="text-[var(--t-text-3)]">{k}</dt><dd className="text-[var(--t-text)]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-col gap-3 border-t border-[var(--t-border)] p-4 md:border-l md:border-t-0">
          <div role="group" aria-label="Direction" className="grid grid-cols-2 gap-2">
            {(["long", "short"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
                className={`h-[36px] rounded-[6px] border text-[13px] font-medium transition-colors ${side === s
                  ? s === "long" ? "border-[var(--t-up)] bg-[var(--t-up)]/10 text-[var(--t-up)]" : "border-[var(--t-down)] bg-[var(--t-down)]/10 text-[var(--t-down)]"
                  : "border-[var(--t-border)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>{s === "long" ? "Long" : "Short"}</button>
            ))}
          </div>
          <div>
            <label htmlFor="basket-size" className="text-[12px] text-[var(--t-text-2)]">Size</label>
            <div className="mt-1 flex h-[38px] items-center rounded-[6px] border border-[var(--t-border)] bg-[var(--t-bg)] px-3 focus-within:border-[var(--t-text-2)]">
              <input id="basket-size" aria-label="Basket size in USD" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tnum w-full bg-transparent text-[14px] text-[var(--t-text)] outline-none" />
              <span className="text-[12px] text-[var(--t-text-3)]">USD</span>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {["1000", "3000", "5000"].map((v) => <button key={v} type="button" onClick={() => setAmount(v)} className={chip(amount === v)}>${Number(v) / 1000}k</button>)}
            </div>
          </div>
          <div>
            <span className="text-[12px] text-[var(--t-text-2)]">Leverage</span>
            <div role="group" aria-label="Leverage" className="mt-1 flex gap-1.5">
              {[1, 2, 3, 5].map((l) => <button key={l} type="button" aria-pressed={leverage === l} onClick={() => setLeverage(l)} className={chip(leverage === l)}>{l}×</button>)}
            </div>
          </div>
          <dl className="tnum space-y-1 border-t border-[var(--t-border)] pt-3 text-[12px]">
            {plan ? plan.map((leg) => (
              <div key={leg.market.symbol} className="flex items-center gap-2">
                <MarketIcon symbol={leg.market.symbol} size={16} />
                <dt className="text-[var(--t-text-2)]">{leg.market.symbol.replace("-PERP", "")}</dt>
                <dd className="ml-auto text-[var(--t-text)]">{leg.quantity.toString()} × {usd(leg.price)}</dd>
              </div>
            )) : <div className="text-[var(--t-text-3)]">Pricing legs…</div>}
            <div className="flex pt-1"><dt className="text-[var(--t-text-3)]">Margin needed</dt><dd className="ml-auto font-medium text-[var(--t-text)]">{marginUsd === null ? "—" : usd(marginUsd)}</dd></div>
          </dl>
          <button type="button" onClick={() => void run()} disabled={!!progress || !(notional > 0)}
            className={`h-[42px] rounded-[8px] text-[14px] font-semibold transition-colors ${progress ? "bg-[var(--t-surface-3)] text-[var(--t-text-2)]" : side === "long" ? "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]" : "bg-[var(--t-down-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-down-2)]"}`}>
            {progress ?? `${side === "long" ? "Buy" : "Short"} ${basket.name} · $${Number.isFinite(notional) ? notional.toLocaleString() : "—"}`}
          </button>
        </div>
      </div>
      {result ? (
        <div role="status" className={`mt-3 rounded-[10px] border px-4 py-3 text-[12.5px] ${result.ok ? "border-[var(--t-border)] bg-[var(--t-surface)]" : "border-[var(--t-down)] text-[var(--t-down)]"}`}>
          {result.ok ? (
            <>
              <div className="font-medium text-[var(--t-text)]">{basket.name} {side === "long" ? "bought" : "shorted"} · {result.legs.length} legs · {result.ms} ms total</div>
              <ul className="tnum mt-1.5 space-y-1 text-[var(--t-text-2)]">
                {result.legs.map((leg) => (
                  <li key={leg.symbol} className="flex items-center gap-3">
                    <MarketIcon symbol={leg.symbol} size={16} />
                    <span className="w-[120px] text-[var(--t-text)]">{leg.symbol}</span>
                    <span>{side === "long" ? "+" : "−"}{leg.quantity.toString()} @ ~{usd(leg.price)}</span>
                    <span>order {leg.ms} ms</span>
                    {leg.signature ? <a className="text-[var(--t-link)] hover:underline" href={rollupExplorer(leg.signature)} target="_blank" rel="noreferrer">View ↗</a> : null}
                  </li>
                ))}
              </ul>
              <Link href={`/trade?market=${result.legs[0]?.symbol ?? ""}`} className="mt-1.5 inline-block text-[var(--t-link)] hover:underline">See positions in the terminal</Link>
            </>
          ) : result.message}
        </div>
      ) : null}
    </section>
  );
}
