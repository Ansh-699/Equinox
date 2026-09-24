"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useAppAuth } from "@/components/app-providers";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { tradingKeySigner } from "@/lib/trading-key";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { V3_MARKETS } from "@/lib/v3-markets";
import { buildGraduateTransaction, buildSwapTransaction, LAUNCH_PRESETS, readPool, type PoolView } from "./dbc-launch";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const explorer = (address: string, kind: "address" | "tx" = "address") => `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;
const money = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : `$${n.toExponential(2)}`);

interface Launch { pool: string; baseMint: string; symbol: string; name: string; preset: string; createdAt: number }
type Row = Launch & { view: PoolView | null };

/** Every Equinox launch, live from the chain: curve progress to graduation,
 * buy/sell on the curve and graduation to DAMM v2, all signed by the trading
 * account; a graduated token shows its Equinox perp once listed. */
export function LaunchMonitor({ refreshKey }: { refreshKey: number }) {
  const auth = useAppAuth();
  const tradingKey = useTradingKey(auth);
  const connection = useMemo(() => new Connection(RPC, "confirmed"), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ pool: string; text: string; href?: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const list = await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/launches`).then((r) => r.json() as Promise<{ launches: Launch[] }>).catch(() => ({ launches: [] }));
      const withState = await Promise.all(list.launches.map(async (launch) => ({ ...launch, view: await readPool(connection, launch.pool).catch(() => null) })));
      if (!stopped) setRows(withState);
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, refreshKey, tick]);

  /** Signs and sends one launch-page transaction with the trading account. */
  async function act(pool: string, label: string, build: (owner: PublicKey) => Promise<{ transaction: { serialize(o: { requireAllSignatures: boolean }): Uint8Array; recentBlockhash?: string }; lastValidBlockHeight: number }>) {
    if (!auth.walletAddress) { setNotice({ pool, text: "Connect a wallet first (top right)." }); return; }
    setBusy(pool);
    setNotice({ pool, text: `${label}…` });
    try {
      const signer = tradingKey.signer ?? tradingKeySigner(await tradingKey.unlock());
      const built = await build(new PublicKey(signer.address!));
      const signed = await signer.signTransaction(built.transaction.serialize({ requireAllSignatures: false }));
      const signature = await connection.sendRawTransaction(signed);
      const outcome = await connection.confirmTransaction({ signature, blockhash: built.transaction.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
      if (outcome.value.err) throw new Error(JSON.stringify(outcome.value.err));
      setNotice({ pool, text: `${label} · done`, href: explorer(signature, "tx") });
      setTick((t) => t + 1);
    } catch (error) {
      setNotice({ pool, text: `${label} failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(null);
    }
  }

  async function sellAll(row: Row) {
    await act(row.pool, `Selling ${row.symbol}`, async (owner) => {
      const balance = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(row.baseMint), owner)).catch(() => null);
      const amount = Number(balance?.value.uiAmount ?? 0);
      if (!(amount > 0)) throw new Error(`your trading account holds no ${row.symbol}`);
      return buildSwapTransaction(connection, { owner, pool: new PublicKey(row.pool), side: "sell", amount, slippageBps: 300 });
    });
  }

  return (
    <section aria-label="Launches" className="mx-auto max-w-[1180px] px-4 pb-10">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--t-text)]">Equinox launches · live from the chain</h2>
        <span className="text-[11.5px] text-[var(--t-text-3)]">Curve → DAMM v2 at graduation → Equinox perp</span>
      </div>
      {!rows ? <p className="mt-3 text-[12px] text-[var(--t-text-2)]">Loading launches…</p> : null}
      {rows?.length === 0 ? <p className="mt-3 text-[12px] text-[var(--t-text-2)]">No launches yet: create the first one above.</p> : null}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {rows?.map((row) => {
          const view = row.view;
          const perp = V3_MARKETS.find((market) => market.oracle.kind === "meteora" && market.oracle.mint === row.baseMint);
          const preset = LAUNCH_PRESETS.find((p) => p.id === row.preset);
          return (
            <div key={row.pool} className="rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-[var(--t-text)]">{row.symbol}</span>
                <span className="truncate text-[12px] text-[var(--t-text-2)]">{row.name}</span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold ${view?.graduated ? "bg-[var(--t-up-soft)] text-[var(--t-up)]" : "bg-[var(--t-surface-3)] text-[var(--t-text)]"}`}>
                  {view?.graduated ? "GRADUATED" : view && view.progress >= 1 ? "READY" : "BONDING"}
                </span>
              </div>
              {view ? (
                <>
                  <div className="mt-3 h-2 overflow-hidden rounded bg-[var(--t-surface-3)]" role="progressbar" aria-valuenow={Math.round(view.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Curve progress to graduation">
                    <div className="h-full rounded bg-[var(--t-up)]" style={{ width: `${Math.round(view.progress * 100)}%` }} />
                  </div>
                  <dl className="tnum mt-2 grid grid-cols-2 gap-y-1 text-[12px]">
                    <dt className="text-[var(--t-text-3)]">Curve progress</dt><dd className="text-right">{(view.progress * 100).toFixed(1)}%</dd>
                    <dt className="text-[var(--t-text-3)]">Raised / to graduate</dt><dd className="text-right">{money(view.raisedUsd)} / {money(view.thresholdUsd)}</dd>
                    <dt className="text-[var(--t-text-3)]">Price · market cap</dt><dd className="text-right">{money(view.price)} · {money(view.marketCap)}</dd>
                    <dt className="text-[var(--t-text-3)]">Curve</dt><dd className="text-right">{preset?.label ?? row.preset}</dd>
                  </dl>
                </>
              ) : <p className="mt-3 text-[12px] text-[var(--t-text-3)]">Pool state unavailable.</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
                {view && !view.graduated && view.progress < 1 ? (
                  <>
                    {[25, 100].map((amount) => (
                      <button key={amount} type="button" disabled={busy === row.pool} onClick={() => void act(row.pool, `Buying $${amount} of ${row.symbol}`, (owner) => buildSwapTransaction(connection, { owner, pool: new PublicKey(row.pool), side: "buy", amount, slippageBps: 300 }))}
                        className="rounded-[6px] bg-[var(--t-up-3)] px-3 py-1.5 font-semibold text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)] disabled:opacity-50">Buy ${amount}</button>
                    ))}
                    <button type="button" disabled={busy === row.pool} onClick={() => void sellAll(row)} className="rounded-[6px] border border-[var(--t-border)] px-3 py-1.5 text-[var(--t-text-2)] hover:text-[var(--t-text)] disabled:opacity-50">Sell all</button>
                  </>
                ) : null}
                {view && !view.graduated && view.progress >= 1 ? (
                  <button type="button" disabled={busy === row.pool} onClick={() => void act(row.pool, `Graduating ${row.symbol} to DAMM v2`, (payer) => buildGraduateTransaction(connection, { payer, pool: new PublicKey(row.pool) }))}
                    className="rounded-[6px] bg-[var(--t-up-3)] px-3 py-1.5 font-semibold text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)] disabled:opacity-50">Graduate to DAMM v2</button>
                ) : null}
                {view?.dammPool ? <a className="text-[var(--t-link)] hover:underline" href={explorer(view.dammPool)} target="_blank" rel="noopener noreferrer">DAMM v2 pool ↗</a> : null}
                {view?.graduated ? (perp
                  ? <Link className="font-semibold text-[var(--t-up)] hover:underline" href={`/trade?market=${perp.symbol}`}>Trade {perp.symbol} ↗</Link>
                  : <span className="text-[11.5px] text-[var(--t-text-3)]">Perp listing: queued for the operator</span>) : null}
                <a className="ml-auto text-[11.5px] text-[var(--t-text-3)] hover:underline" href={explorer(row.pool)} target="_blank" rel="noopener noreferrer">Pool ↗</a>
              </div>
              {notice?.pool === row.pool ? (
                <p role="status" className="mt-2 text-[12px] text-[var(--t-text-2)]">{notice.text}{notice.href ? <> · <a className="text-[var(--t-link)] hover:underline" href={notice.href} target="_blank" rel="noreferrer">View ↗</a></> : null}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
