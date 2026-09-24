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
import { formatCompactUsd, formatTinyUsd } from "./format";
import { Badge, EmptyState, Skeleton, type Tone } from "@/components/ui/primitives";
import { Rocket } from "lucide-react";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet";
const explorer = (address: string, kind: "address" | "tx" = "address") => `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;
const AVATAR_COLORS = ["#16a34a", "#2563eb", "#9333ea", "#db2777", "#ea580c", "#0891b2", "#ca8a04"];

/** Coloured initial for a token, stable per symbol. */
export function TokenAvatar({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const hash = [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.38, background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}>
      {symbol.slice(0, 2)}
    </span>
  );
}

type Stage = "bonding" | "ready" | "graduated";
const stageOf = (view: PoolView | null): Stage => (view?.graduated ? "graduated" : view && view.progress >= 1 ? "ready" : "bonding");
const STAGE: Record<Stage, { label: string; tone: Tone }> = {
  bonding: { label: "Bonding", tone: "link" },
  ready: { label: "Ready to graduate", tone: "warn" },
  graduated: { label: "Graduated", tone: "up" },
};
const FILTERS = [
  { id: "all", label: "All" },
  { id: "bonding", label: "Bonding" },
  { id: "ready", label: "Ready" },
  { id: "graduated", label: "Graduated" },
] as const;

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const list = await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/launches`).then((r) => r.json() as Promise<{ launches: Launch[] }>).catch(() => null);
      if (stopped) return;
      setLoadFailed(!list);
      if (!list) { setRows((current) => current ?? []); return; }
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

  const counts = { all: rows?.length ?? 0, bonding: 0, ready: 0, graduated: 0 };
  rows?.forEach((row) => { counts[stageOf(row.view)] += 1; });
  const shown = rows?.filter((row) => filter === "all" || stageOf(row.view) === filter) ?? [];
  const BTN = "h-[32px] rounded-[8px] px-3 text-[12.5px] font-semibold transition-colors disabled:opacity-50";

  return (
    <section aria-label="Launches">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-[var(--t-text)]">Live launches</h2>
          <p className="text-[12px] text-[var(--t-text-3)]">Read live from Solana every 10s. Buy on the curve; at 100% anyone can graduate it.</p>
        </div>
        <div role="group" aria-label="Filter launches" className="flex gap-1 rounded-[8px] bg-[var(--t-surface-3)] p-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              className={`h-[26px] rounded-[6px] px-2.5 text-[12px] font-medium ${filter === f.id ? "bg-[var(--t-bg)] text-[var(--t-text)] shadow-sm" : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>
              {f.label} <span className="tnum text-[var(--t-text-3)]">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      {!rows ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[0, 1].map((i) => <div key={i} className="space-y-3 rounded-[12px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4"><Skeleton className="h-9 w-40" /><Skeleton className="h-2 w-full" /><Skeleton className="h-4 w-32" /></div>)}
        </div>
      ) : null}
      {rows && shown.length === 0 ? (
        <div className="mt-3 rounded-[12px] border border-dashed border-[var(--t-border-strong)]">
          <EmptyState icon={<Rocket className="h-5 w-5" />} title={loadFailed && rows.length === 0 ? "Couldn't load launches" : rows.length === 0 ? "No launches yet" : "Nothing in this stage"}>
            {loadFailed && rows.length === 0 ? "The launch registry isn't answering. Retrying every 10 seconds." : rows.length === 0 ? "Create the first one with the form alongside." : "Try another filter."}
          </EmptyState>
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {shown.map((row) => {
          const view = row.view;
          const stage = stageOf(view);
          const perp = V3_MARKETS.find((market) => market.oracle.kind === "meteora" && market.oracle.mint === row.baseMint);
          const preset = LAUNCH_PRESETS.find((p) => p.id === row.preset);
          const pct = view ? Math.min(100, view.progress * 100) : 0;
          return (
            <article key={row.pool} className="flex flex-col rounded-[12px] border border-[var(--t-border)] bg-[var(--t-surface)] p-4 transition-colors hover:border-[var(--t-border-strong)]">
              <div className="flex items-center gap-3">
                <TokenAvatar symbol={row.symbol} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14.5px] font-semibold text-[var(--t-text)]">{row.symbol}</h3>
                  <p className="truncate text-[12px] text-[var(--t-text-3)]">{row.name}{preset ? ` · ${preset.label}` : ""}</p>
                </div>
                <Badge tone={STAGE[stage].tone} dot>{STAGE[stage].label}</Badge>
              </div>
              {view ? (
                <>
                  <div className="tnum mt-4 flex items-baseline justify-between text-[12px]">
                    <span className="text-[var(--t-text-2)]"><b className="text-[var(--t-text)]">{formatCompactUsd(view.raisedUsd)}</b> of {formatCompactUsd(view.thresholdUsd)} raised</span>
                    <span className="font-semibold text-[var(--t-text)]">{pct.toFixed(pct >= 10 ? 0 : 1)}%</span>
                  </div>
                  <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-[var(--t-surface-3)]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.symbol} curve progress to graduation`}>
                    <div className="h-full rounded-full bg-gradient-to-r from-[var(--t-up-3)] to-[var(--t-up)]" style={{ width: `${pct}%` }} />
                  </div>
                  <dl className="tnum mt-3 grid grid-cols-2 gap-2 text-[12px]">
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-2.5 py-1.5"><dt className="text-[10.5px] text-[var(--t-text-3)]">Price</dt><dd className="font-semibold text-[var(--t-text)]" title={`$${view.price}`}>{formatTinyUsd(view.price)}</dd></div>
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-2.5 py-1.5"><dt className="text-[10.5px] text-[var(--t-text-3)]">Market cap</dt><dd className="font-semibold text-[var(--t-text)]">{formatCompactUsd(view.marketCap)}</dd></div>
                  </dl>
                </>
              ) : <p className="mt-3 text-[12px] text-[var(--t-text-3)]">Pool state unavailable right now.</p>}
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-[12.5px]">
                {view && stage === "bonding" ? (
                  <>
                    {[25, 100].map((amount) => (
                      <button key={amount} type="button" disabled={busy === row.pool} onClick={() => void act(row.pool, `Buying $${amount} of ${row.symbol}`, (owner) => buildSwapTransaction(connection, { owner, pool: new PublicKey(row.pool), side: "buy", amount, slippageBps: 300 }))}
                        className={`${BTN} bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]`}>Buy ${amount}</button>
                    ))}
                    <button type="button" disabled={busy === row.pool} onClick={() => void sellAll(row)} className={`${BTN} border border-[var(--t-border-strong)] font-medium text-[var(--t-text-2)] hover:text-[var(--t-text)]`}>Sell all</button>
                  </>
                ) : null}
                {view && stage === "ready" ? (
                  <button type="button" disabled={busy === row.pool} onClick={() => void act(row.pool, `Graduating ${row.symbol} to DAMM v2`, (payer) => buildGraduateTransaction(connection, { payer, pool: new PublicKey(row.pool) }))}
                    className={`${BTN} bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]`}>Graduate to Meteora</button>
                ) : null}
                {stage === "graduated" ? (perp
                  ? <Link className={`${BTN} inline-flex items-center bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]`} href={`/trade?market=${perp.symbol}`}>Trade {perp.symbol} perp</Link>
                  : <span className="text-[11.5px] text-[var(--t-text-3)]">Perp listing queued</span>) : null}
                <span className="ml-auto flex items-center gap-3 text-[11.5px]">
                  {view?.dammPool ? <a className="text-[var(--t-link)] hover:underline" href={explorer(view.dammPool)} target="_blank" rel="noopener noreferrer">Meteora pool ↗</a> : null}
                  <a className="text-[var(--t-text-3)] hover:underline" href={explorer(row.pool)} target="_blank" rel="noopener noreferrer">Curve ↗</a>
                </span>
              </div>
              {notice?.pool === row.pool ? (
                <p role="status" className="mt-2 break-words text-[12px] text-[var(--t-text-2)]">{notice.text}{notice.href ? <> · <a className="text-[var(--t-link)] hover:underline" href={notice.href} target="_blank" rel="noreferrer">View ↗</a></> : null}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
