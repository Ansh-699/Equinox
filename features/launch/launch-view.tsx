"use client";

import { useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Rocket } from "lucide-react";
import { openWalletDrawer, TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { tradingKeySigner } from "@/lib/trading-key";
import { claimTestFunds } from "@/lib/faucet-client";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { LaunchMonitor } from "./launch-monitor";
import { HINT, PanelHead, primaryBtn } from "@/features/trading/lifecycle-panel";
import { buildLaunchTransaction, describePreset, LAUNCH_PRESETS, TOTAL_SUPPLY, type LaunchPreset } from "./dbc-launch";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const STOCKS = ["TSLA", "AAPL", "NVDA"] as const;
const INPUT = "h-[34px] w-full rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-[10px] text-[13px] text-[var(--t-text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";
const explorer = (address: string, kind: "address" | "tx" = "address") => `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;

type Result = { pool: string; mint: string; config: string; signature: string };
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Fee over time for the preset's linear decay, as an SVG path. */
function FeeCurve({ preset }: { preset: LaunchPreset }) {
  const W = 260, H = 70;
  const y = (bps: number) => H - 6 - (bps / 500) * (H - 12);
  const decayX = preset.decayMinutes ? Math.min(W - 10, (preset.decayMinutes / 180) * W) : 0;
  const d = `M0,${y(preset.startingFeeBps)} L${decayX},${y(preset.endingFeeBps)} L${W},${y(preset.endingFeeBps)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[70px] w-full" aria-label={`Fee decays from ${preset.startingFeeBps} to ${preset.endingFeeBps} bps`}>
      <line x1={0} x2={W} y1={H - 6} y2={H - 6} stroke="var(--t-border)" />
      <path d={d} fill="none" stroke="var(--t-up)" strokeWidth={2} />
    </svg>
  );
}

/** Meteora DBC launchpad for stock-themed tokens, signed by the Privy wallet. */
export function LaunchView() {
  const auth = useAppAuth();
  const tradingKey = useTradingKey(auth);
  const [refreshKey, setRefreshKey] = useState(0);
  const [preset, setPreset] = useState<LaunchPreset>(LAUNCH_PRESETS[0]);
  const [stock, setStock] = useState<(typeof STOCKS)[number]>("TSLA");
  const [name, setName] = useState("Tesla Believers");
  const [symbol, setSymbol] = useState("TSLAB");
  const [uri, setUri] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const summary = describePreset(preset);
  const connection = useMemo(() => new Connection(RPC, "confirmed"), []);

  async function launch() {
    if (!auth.authenticated || !auth.walletAddress) { openWalletDrawer(); return; }
    if (!name.trim() || !/^[A-Z0-9]{2,10}$/.test(symbol)) { setStatus("Give the token a name and a 2–10 character symbol (A–Z, 0–9)."); return; }
    setPending(true);
    setResult(null);
    try {
      // Signed by the trading account (one wallet prompt the first time on this device).
      const signer = tradingKey.signer ?? tradingKeySigner(await tradingKey.unlock());
      const creator = new PublicKey(signer.address!);
      // Rent for the config, pool and mint (~0.02 SOL): the faucet tops up SOL and test USDC.
      if ((await connection.getBalance(creator)) < 30_000_000) {
        setStatus("Funding your trading account with devnet SOL and test USDC…");
        await claimTestFunds({ privyAuthenticated: false, getAccessToken: async () => null, signMessage: (_a: string, bytes: Uint8Array) => signer.signMessage(bytes) }, signer.address!);
        for (let i = 0; i < 20 && (await connection.getBalance(creator)) < 30_000_000; i += 1) await new Promise((r) => setTimeout(r, 1_000));
      }
      setStatus("Building the Meteora DBC config and pool…");
      const built = await buildLaunchTransaction(connection, {
        name: name.trim(), symbol, uri: uri.trim() || `${location.origin}/favicon.svg`, preset, creator,
      });
      setStatus("Creating the pool on Solana devnet…");
      const signed = await signer.signTransaction(built.transaction.serialize({ requireAllSignatures: false }));
      setStatus("Sending to Solana devnet…");
      const signature = await connection.sendRawTransaction(signed);
      const outcome = await connection.confirmTransaction({ signature, blockhash: built.transaction.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
      if (outcome.value.err) throw new Error(`launch failed: ${JSON.stringify(outcome.value.err)}`);
      setResult({ pool: built.pool.toBase58(), mint: built.baseMint.toBase58(), config: built.config.toBase58(), signature });
      // List it on the Launch page for everyone (display registry; the chain is the truth).
      await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/launches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: built.pool.toBase58(), baseMint: built.baseMint.toBase58(), symbol, name: name.trim(), preset: preset.id }) }).catch(() => undefined);
      setRefreshKey((k) => k + 1);
      setStatus(null);
    } catch (error) {
      setStatus(`Not launched: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="terminal min-h-screen">
      <TopBar active="launch" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto grid max-w-[1180px] gap-4 px-4 py-6 outline-none lg:grid-cols-[1fr_360px]">
        <section className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-bg)]">
          <div className="border-b border-[var(--t-border)] p-5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-3)]">
              <Rocket className="h-3.5 w-3.5" /> Launch · powered by Meteora Dynamic Bonding Curve
            </div>
            <h1 className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--t-text)]">Launch a stock-themed token with an equity-tuned curve</h1>
            <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-[var(--t-text-2)]">
              Most bonding curves are tuned for memecoins and priced in SOL. These are priced in dollars (test USDC) and tuned for equity-like assets: decaying launch fees against opening-day sniping, volatility-scaled dynamic fees, and permanently locked liquidity when the pool graduates to Meteora DAMM v2. A graduated token can then be listed as a StockStream perp, priced from its DAMM v2 pool.
            </p>
          </div>

          <div className="grid gap-3 p-5 md:grid-cols-2" role="radiogroup" aria-label="Curve preset">
            {LAUNCH_PRESETS.map((p) => {
              const on = p.id === preset.id;
              const s = describePreset(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPreset(p)}
                  className={`flex flex-col gap-2 rounded-[6px] border p-3 text-left transition-colors ${on ? "border-[var(--t-up)] bg-[var(--t-up-soft)]" : "border-[var(--t-border-strong)] bg-[var(--t-surface)] hover:bg-[var(--t-surface-3)]"}`}
                >
                  <span className="text-[13px] font-semibold text-[var(--t-text)]">{p.label}</span>
                  <span className="text-[11.5px] leading-snug text-[var(--t-text-2)]">{p.blurb}</span>
                  <FeeCurve preset={p} />
                  <span className="tnum text-[11px] text-[var(--t-text-3)]">
                    {p.startingFeeBps / 100}% → {p.endingFeeBps / 100}% fee{p.decayMinutes ? ` over ${p.decayMinutes}m` : ""} · {s.priceMultiple.toFixed(1)}× to graduate
                  </span>
                </button>
              );
            })}
          </div>

          <dl className="grid grid-cols-2 gap-px border-t border-[var(--t-border)] bg-[var(--t-border)] md:grid-cols-4">
            {[
              ["Start market cap", usd(preset.initialMarketCap)],
              ["Graduates at", usd(preset.migrationMarketCap)],
              ["Dynamic fee", preset.dynamicFee ? "volatility-scaled" : "off"],
              ["Locked at graduation", `${preset.lockedLiquidityPercentage}% of LP`],
              ["Supply", `${(TOTAL_SUPPLY / 1e9).toFixed(0)}B tokens`],
              ["Start price", `$${summary.startPrice.toExponential(2)}`],
              ["Graduation price", `$${summary.graduationPrice.toExponential(2)}`],
              ["Migrates to", "Meteora DAMM v2"],
            ].map(([k, v]) => (
              <div key={k} className="bg-[var(--t-bg)] px-4 py-3">
                <dt className="text-[10.5px] text-[var(--t-text-3)]">{k}</dt>
                <dd className="tnum mt-1 text-[13px] font-medium text-[var(--t-text)]">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <aside className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-bg)]">
          <PanelHead title="Create pool" badge="devnet" />
          <div className="space-y-3 p-3">
            <label className="flex flex-col gap-1.5 text-[12px] text-[var(--t-text-2)]">Themed on
              <div className="grid grid-cols-3 gap-1">
                {STOCKS.map((s) => (
                  <button key={s} type="button" aria-pressed={stock === s} onClick={() => setStock(s)} className={`h-[30px] rounded-[4px] border text-[12px] ${stock === s ? "border-[var(--t-up)] text-[var(--t-up)]" : "border-[var(--t-border-strong)] text-[var(--t-text-2)]"}`}>{s}</button>
                ))}
              </div>
            </label>
            <label className="flex flex-col gap-1.5 text-[12px] text-[var(--t-text-2)]">Token name<input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} /></label>
            <label className="flex flex-col gap-1.5 text-[12px] text-[var(--t-text-2)]">Symbol<input className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={10} /></label>
            <label className="flex flex-col gap-1.5 text-[12px] text-[var(--t-text-2)]">Metadata URI (optional)<input className={INPUT} value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://…/metadata.json" /></label>
            <button type="button" className={primaryBtn(pending)} disabled={pending} onClick={() => void launch()}>
              {!auth.authenticated ? "Sign in to launch" : pending ? "Launching…" : `Launch ${symbol || "token"} on Meteora`}
            </button>
            <p className={HINT}>Signed by your trading account (one wallet prompt the first time). Creates a DBC config (the {preset.label.toLowerCase()} curve) and a {stock}-themed pool priced in test USDC; the creator keeps creator fees and the creator LP share. ~0.02 devnet SOL of rent, topped up from the faucet.</p>
            {status ? <p role="status" className="text-[12px] text-[var(--t-text-2)]">{status}</p> : null}
            {result ? (
              <div className="space-y-1 rounded-[4px] border border-[var(--t-up)] bg-[var(--t-up-soft)] p-2.5 text-[12px]">
                <p className="font-semibold text-[var(--t-up)]">Pool live on devnet</p>
                <a className="block underline" href={explorer(result.pool)} target="_blank" rel="noopener noreferrer">Pool {result.pool.slice(0, 6)}…</a>
                <a className="block underline" href={explorer(result.mint)} target="_blank" rel="noopener noreferrer">Token mint {result.mint.slice(0, 6)}…</a>
                <a className="block underline" href={explorer(result.signature, "tx")} target="_blank" rel="noopener noreferrer">Transaction</a>
              </div>
            ) : null}
          </div>
        </aside>
      </main>
      <LaunchMonitor refreshKey={refreshKey} />
    </div>
  );
}

