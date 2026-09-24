"use client";

import { useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Check, ChevronRight, Loader2, Rocket } from "lucide-react";
import { openWalletDrawer, TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { tradingKeySigner } from "@/lib/trading-key";
import { claimTestFunds } from "@/lib/faucet-client";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { Badge, BUTTON_PRIMARY, FOCUS_RING, InfoTip } from "@/components/ui/primitives";
import { LaunchMonitor, TokenAvatar } from "./launch-monitor";
import { buildLaunchTransaction, describePreset, LAUNCH_PRESETS, TOTAL_SUPPLY, type LaunchPreset } from "./dbc-launch";
import { formatCompactUsd, formatTinyUsd } from "./format";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const STOCKS = ["TSLA", "AAPL", "NVDA"] as const;
const INPUT = `h-[38px] w-full rounded-[8px] border border-[var(--t-border-strong)] bg-[var(--t-bg)] px-3 text-[13.5px] text-[var(--t-text)] ${FOCUS_RING}`;
const explorer = (address: string, kind: "address" | "tx" = "address") => `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;

type Result = { pool: string; mint: string; config: string; signature: string };

type Phase = "fund" | "build" | "sign" | "confirm" | "done";
const PHASES: { id: Exclude<Phase, "done">; label: string }[] = [
  { id: "fund", label: "Fund trading account" },
  { id: "build", label: "Build curve and pool" },
  { id: "sign", label: "Sign" },
  { id: "confirm", label: "Confirm on Solana" },
];

/** The launch fee over the first three hours, with % gridlines. */
function FeeChart({ preset }: { preset: LaunchPreset }) {
  const W = 320, H = 120, L = 30, B = 18, T = 8;
  const maxBps = 500;
  const x = (minutes: number) => L + (minutes / 180) * (W - L - 4);
  const y = (bps: number) => T + (1 - bps / maxBps) * (H - T - B);
  const decay = Math.min(180, preset.decayMinutes);
  const d = `M${x(0)},${y(preset.startingFeeBps)} L${x(decay)},${y(preset.endingFeeBps)} L${x(180)},${y(preset.endingFeeBps)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" role="img" aria-label={`Launch fee starts at ${preset.startingFeeBps / 100}% and settles at ${preset.endingFeeBps / 100}%${preset.decayMinutes ? ` after ${preset.decayMinutes} minutes` : ""}`}>
      {[0, 100, 300, 500].map((bps) => (
        <g key={bps}>
          <line x1={L} x2={W - 4} y1={y(bps)} y2={y(bps)} stroke="var(--t-border)" strokeDasharray={bps ? "3 3" : undefined} />
          <text x={L - 6} y={y(bps) + 3} textAnchor="end" fontSize="9" fill="var(--t-text-3)">{bps / 100}%</text>
        </g>
      ))}
      {[0, 60, 120, 180].map((m) => <text key={m} x={x(m)} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--t-text-3)">{m === 0 ? "launch" : `${m / 60}h`}</text>)}
      <path d={`${d} L${x(180)},${y(0)} L${x(0)},${y(0)} Z`} fill="var(--t-up-soft)" />
      <path d={d} fill="none" stroke="var(--t-up)" strokeWidth={2.25} strokeLinejoin="round" />
      <circle cx={x(0)} cy={y(preset.startingFeeBps)} r={3} fill="var(--t-up)" />
    </svg>
  );
}

function StepHead({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--t-text)] text-[11.5px] font-bold text-[var(--t-bg)]">{n}</span>
      <div>
        <h3 className="text-[13.5px] font-semibold text-[var(--t-text)]">{title}</h3>
        {hint ? <p className="text-[11.5px] text-[var(--t-text-3)]">{hint}</p> : null}
      </div>
    </div>
  );
}

const feeLabel = (p: LaunchPreset) => (p.startingFeeBps === p.endingFeeBps ? `${p.startingFeeBps / 100}% flat fee` : `${p.startingFeeBps / 100}% → ${p.endingFeeBps / 100}% fee`);

/** Meteora DBC launchpad for stock-themed tokens, signed by the trading account. */
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
  const [phase, setPhase] = useState<Phase | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const summary = describePreset(preset);
  const connection = useMemo(() => new Connection(RPC, "confirmed"), []);
  const symbolValid = /^[A-Z0-9]{2,10}$/.test(symbol);

  async function launch() {
    if (!auth.authenticated || !auth.walletAddress) { openWalletDrawer(); return; }
    if (!name.trim() || !/^[A-Z0-9]{2,10}$/.test(symbol)) { setStatus("Give the token a name and a 2–10 character symbol (A–Z, 0–9)."); return; }
    setPending(true);
    setResult(null);
    setStatus(null);
    setPhase("fund");
    try {
      // Signed by the trading account (one wallet prompt the first time on this device).
      const signer = tradingKey.signer ?? tradingKeySigner(await tradingKey.unlock());
      const creator = new PublicKey(signer.address!);
      // Rent for the config, pool and mint (~0.02 SOL): the faucet tops up SOL and test USDC.
      if ((await connection.getBalance(creator)) < 30_000_000) {
        await claimTestFunds({ privyAuthenticated: false, getAccessToken: async () => null, signMessage: (_a: string, bytes: Uint8Array) => signer.signMessage(bytes) }, signer.address!);
        for (let i = 0; i < 20 && (await connection.getBalance(creator)) < 30_000_000; i += 1) await new Promise((r) => setTimeout(r, 1_000));
      }
      setPhase("build");
      const built = await buildLaunchTransaction(connection, {
        name: name.trim(), symbol, uri: uri.trim() || `${location.origin}/favicon.svg`, preset, creator,
      });
      setPhase("sign");
      const signed = await signer.signTransaction(built.transaction.serialize({ requireAllSignatures: false }));
      setPhase("confirm");
      const signature = await connection.sendRawTransaction(signed);
      const outcome = await connection.confirmTransaction({ signature, blockhash: built.transaction.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
      if (outcome.value.err) throw new Error(`launch failed: ${JSON.stringify(outcome.value.err)}`);
      setResult({ pool: built.pool.toBase58(), mint: built.baseMint.toBase58(), config: built.config.toBase58(), signature });
      // List it on the Launch page for everyone (display registry; the chain is the truth).
      await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/launches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: built.pool.toBase58(), baseMint: built.baseMint.toBase58(), symbol, name: name.trim(), preset: preset.id }) }).catch(() => undefined);
      setRefreshKey((k) => k + 1);
      setPhase("done");
    } catch (error) {
      setPhase(null);
      setStatus(`Not launched: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="terminal min-h-screen">
      <TopBar active="launch" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <section className="relative overflow-hidden rounded-[12px] border border-[var(--t-border)] bg-[var(--t-surface)] px-5 py-6 sm:px-7">
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-[var(--t-up-soft)] blur-3xl" />
          <Badge tone="up"><Rocket className="h-3 w-3" /> Launchpad · devnet</Badge>
          <h1 className="mt-3 text-[26px] font-semibold tracking-tight text-[var(--t-text)] sm:text-[30px]">Launch a stock-themed token</h1>
          <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-[var(--t-text-2)]">
            Priced in dollars (test USDC), it trades on a bonding curve until enough is raised, then graduates to a Meteora pool with locked
            liquidity, and can be listed as an Equinox perp.
          </p>
          <ol className="mt-5 grid gap-2 sm:grid-cols-3">
            {[
              ["Pick a curve", "How fees and price behave on day one"],
              ["Name it", "A symbol and the stock it's themed on"],
              ["Launch & watch it graduate", "Buyers push it up the curve to graduation"],
            ].map(([title, hint], index) => (
              <li key={title} className="flex items-center gap-3 rounded-[10px] border border-[var(--t-border)] bg-[var(--t-bg)] px-3 py-2.5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--t-up-soft)] text-[12px] font-bold text-[var(--t-up)]">{index + 1}</span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--t-text)]">{title}</div>
                  <div className="truncate text-[11.5px] text-[var(--t-text-3)]">{hint}</div>
                </div>
                {index < 2 ? <ChevronRight className="ml-auto hidden h-4 w-4 text-[var(--t-text-3)] sm:block" /> : null}
              </li>
            ))}
          </ol>
          <details className="mt-4 text-[12.5px] text-[var(--t-text-2)]">
            <summary className="cursor-pointer font-medium hover:text-[var(--t-text)]">How it works</summary>
            <p className="mt-2 max-w-[75ch] leading-relaxed text-[var(--t-text-3)]">
              Launches use Meteora&apos;s Dynamic Bonding Curve (DBC). Most bonding curves are tuned for memecoins and priced in SOL; these are
              priced in USDC and tuned for equity-like assets: a launch fee that decays over the first hours to blunt opening-day sniping,
              optional volatility-scaled dynamic fees, and a share of liquidity locked forever when the pool graduates to Meteora DAMM v2.
              A graduated token can then be listed as an Equinox perp, priced from its DAMM v2 pool.
            </p>
          </details>
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_390px]">
          <div className="min-w-0">
            <LaunchMonitor refreshKey={refreshKey} />
          </div>

          <aside aria-label="Create a launch" className="self-start rounded-[12px] border border-[var(--t-border)] bg-[var(--t-surface)] lg:sticky lg:top-4">
            <div className="flex items-center justify-between border-b border-[var(--t-border)] px-4 py-3">
              <h2 className="text-[14px] font-semibold text-[var(--t-text)]">Create a launch</h2>
              <Badge tone="muted">~0.02 SOL rent, covered</Badge>
            </div>

            <div className="space-y-5 p-4">
              <section className="space-y-3">
                <StepHead n={1} title="Pick a curve" />
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Curve preset">
                  {LAUNCH_PRESETS.map((p) => {
                    const on = p.id === preset.id;
                    return (
                      <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPreset(p)}
                        className={`rounded-[8px] border px-3 py-2 text-left transition-colors ${FOCUS_RING} ${on ? "border-[var(--t-up)] bg-[var(--t-up-soft)]" : "border-[var(--t-border-strong)] hover:bg-[var(--t-surface-3)]"}`}>
                        <span className="block text-[12.5px] font-semibold text-[var(--t-text)]">{p.label}</span>
                        <span className="tnum block text-[11px] text-[var(--t-text-3)]">{feeLabel(p)} · {describePreset(p).priceMultiple.toFixed(0)}×</span>
                      </button>
                    );
                  })}
                </div>
                <div className="rounded-[10px] border border-[var(--t-border)] bg-[var(--t-bg)] p-3">
                  <p className="text-[12px] leading-relaxed text-[var(--t-text-2)]">{preset.blurb}</p>
                  <FeeChart preset={preset} />
                  <dl className="tnum mt-1 grid grid-cols-2 gap-2 text-[12px]">
                    <div><dt className="text-[10.5px] text-[var(--t-text-3)]">Starts at</dt><dd className="font-semibold text-[var(--t-text)]">{formatCompactUsd(preset.initialMarketCap)} cap</dd></div>
                    <div><dt className="text-[10.5px] text-[var(--t-text-3)]">Graduates at</dt><dd className="font-semibold text-[var(--t-text)]">{formatCompactUsd(preset.migrationMarketCap)} cap</dd></div>
                    <div><dt className="text-[10.5px] text-[var(--t-text-3)]">Liquidity locked</dt><dd className="font-semibold text-[var(--t-text)]">{preset.lockedLiquidityPercentage}% forever</dd></div>
                    <div>
                      <dt className="flex items-center gap-1 text-[10.5px] text-[var(--t-text-3)]">Price <InfoTip text={`${(TOTAL_SUPPLY / 1e9).toFixed(0)}B token supply. Dynamic fee: ${preset.dynamicFee ? "volatility-scaled surcharge on" : "off"}. Graduates to Meteora DAMM v2.`} /></dt>
                      <dd className="font-semibold text-[var(--t-text)]">{formatTinyUsd(summary.startPrice)} → {formatTinyUsd(summary.graduationPrice)}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              <section className="space-y-3">
                <StepHead n={2} title="Name it" />
                <div>
                  <span className="text-[12px] font-medium text-[var(--t-text-2)]" id="themed-on">Themed on</span>
                  <div className="mt-1.5 grid grid-cols-3 gap-1.5" role="group" aria-labelledby="themed-on">
                    {STOCKS.map((s) => (
                      <button key={s} type="button" aria-pressed={stock === s} onClick={() => setStock(s)}
                        className={`h-[34px] rounded-[8px] border text-[12.5px] font-semibold ${FOCUS_RING} ${stock === s ? "border-[var(--t-up)] bg-[var(--t-up-soft)] text-[var(--t-up)]" : "border-[var(--t-border-strong)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>{s}</button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-[1fr_120px] gap-2">
                  <label className="flex flex-col gap-1.5 text-[12px] font-medium text-[var(--t-text-2)]">Token name<input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} /></label>
                  <label className="flex flex-col gap-1.5 text-[12px] font-medium text-[var(--t-text-2)]">Symbol<input className={`${INPUT} font-mono uppercase`} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} maxLength={10} aria-invalid={!symbolValid} /></label>
                </div>
                {!symbolValid ? <p className="text-[11.5px] text-[var(--t-warn)]">Symbol needs 2–10 letters or digits.</p> : null}
                <details className="text-[12px] text-[var(--t-text-2)]">
                  <summary className="cursor-pointer font-medium hover:text-[var(--t-text)]">Advanced</summary>
                  <label className="mt-2 flex flex-col gap-1.5 text-[12px] font-medium">Metadata URI (optional)<input className={INPUT} value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://…/metadata.json" /></label>
                </details>
              </section>

              <section className="space-y-3">
                <StepHead n={3} title="Launch" />
                <div className="rounded-[10px] border border-dashed border-[var(--t-border-strong)] p-3" aria-label="Preview">
                  <div className="flex items-center gap-2.5">
                    <TokenAvatar symbol={symbol || "?"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="text-[13.5px] font-semibold text-[var(--t-text)]">{symbol || "SYMBOL"}</span><Badge tone="muted">{stock}</Badge></div>
                      <div className="truncate text-[11.5px] text-[var(--t-text-3)]">{name || "Token name"}</div>
                    </div>
                    <Badge tone="link">Bonding</Badge>
                  </div>
                  <div className="mt-2.5 h-1.5 rounded-full bg-[var(--t-surface-3)]" />
                  <div className="tnum mt-1.5 flex justify-between text-[11px] text-[var(--t-text-3)]"><span>0% to graduation</span><span>{formatTinyUsd(summary.startPrice)}</span></div>
                </div>
                <button type="button" className={`${BUTTON_PRIMARY} h-[42px] w-full text-[14px]`} disabled={pending || (auth.authenticated && (!symbolValid || !name.trim()))} onClick={() => void launch()}>
                  {!auth.authenticated ? "Connect wallet to launch" : pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Launching…</> : `Launch ${symbol || "token"}`}
                </button>
                {phase && phase !== "done" ? (
                  <ol className="space-y-1.5" aria-label="Launch progress">
                    {PHASES.map((step, index) => {
                      const current = PHASES.findIndex((p) => p.id === phase);
                      const state = index < current ? "done" : index === current ? "active" : "todo";
                      return (
                        <li key={step.id} className={`flex items-center gap-2 text-[12.5px] ${state === "todo" ? "text-[var(--t-text-3)]" : "text-[var(--t-text)]"}`}>
                          {state === "done" ? <Check className="h-4 w-4 text-[var(--t-up)]" /> : state === "active" ? <Loader2 className="h-4 w-4 animate-spin text-[var(--t-up)]" /> : <span className="grid h-4 w-4 place-items-center"><span className="h-1.5 w-1.5 rounded-full bg-[var(--t-text-3)]" /></span>}
                          {step.label}
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
                <p className="text-[11px] leading-relaxed text-[var(--t-text-3)]">Signed by your in-app trading account (one wallet prompt the first time). You keep the creator fees and the creator share of liquidity. Devnet SOL for rent is topped up from the faucet.</p>
                {status ? <p role="status" className="rounded-[8px] bg-[var(--t-down-soft)] px-3 py-2 text-[12px] text-[var(--t-down)]">{status}</p> : null}
                {result ? (
                  <div role="status" className="space-y-2 rounded-[10px] border border-[var(--t-up)] bg-[var(--t-up-soft)] p-3 text-[12.5px]">
                    <p className="flex items-center gap-1.5 font-semibold text-[var(--t-up)]"><Check className="h-4 w-4" /> {symbol} is live on devnet</p>
                    <p className="text-[var(--t-text-2)]">It&apos;s now in the launches list. Be the first buyer to start it up the curve.</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <a className="text-[var(--t-link)] hover:underline" href={explorer(result.pool)} target="_blank" rel="noopener noreferrer">Pool ↗</a>
                      <a className="text-[var(--t-link)] hover:underline" href={explorer(result.mint)} target="_blank" rel="noopener noreferrer">Token mint ↗</a>
                      <a className="text-[var(--t-link)] hover:underline" href={explorer(result.signature, "tx")} target="_blank" rel="noopener noreferrer">Transaction ↗</a>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
