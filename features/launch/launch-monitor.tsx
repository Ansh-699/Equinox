"use client";
/* eslint-disable @next/next/no-img-element -- token images come from each launch's own metadata URI */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChefHat, Clock, Copy, Crown, ExternalLink, Search, Users, Zap } from "lucide-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useAppAuth } from "@/components/app-providers";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { tradingKeySigner } from "@/lib/trading-key";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { V3_MARKETS } from "@/lib/v3-markets";
import { buildGraduateTransaction, buildSwapTransaction, LAUNCH_PRESETS, readPool, type PoolView } from "./dbc-launch";
import { readLaunchStats, type LaunchStats } from "./launch-stats";
import { formatCompactUsd } from "./format";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://rpc.magicblock.app/devnet";
const explorer = (address: string, kind: "address" | "tx" = "address") => `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;
const age = (ms: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};

interface Launch { pool: string; baseMint: string; symbol: string; name: string; preset: string; createdAt: number }
type Row = Launch & { view: PoolView | null; stats: LaunchStats | null };
type Stage = "new" | "final" | "graduated";
/** Final stretch starts at 60% of the curve (Axiom's column between new pairs and migrated). */
const FINAL_STRETCH = 0.6;
const stageOf = (row: Row): Stage => (row.view?.graduated ? "graduated" : (row.view?.progress ?? 0) >= FINAL_STRETCH ? "final" : "new");
const COLUMNS: { stage: Stage; title: string; hint: string }[] = [
  { stage: "new", title: "New pairs", hint: "On the bonding curve" },
  { stage: "final", title: "Final stretch", hint: `≥ ${FINAL_STRETCH * 100}% to graduation` },
  { stage: "graduated", title: "Graduated", hint: "Migrated to Meteora DAMM v2" },
];

/** Pulse: every Equinox launch in three live columns by lifecycle stage, read
 * from the chain (curve, holders, fees, transactions). Buys, sells and
 * graduation are signed by the in-app trading account; a graduated token links
 * to its Equinox perp once listed. */
export function LaunchMonitor({ refreshKey, quickBuyUsd }: { refreshKey: number; quickBuyUsd: number }) {
  const auth = useAppAuth();
  const tradingKey = useTradingKey(auth);
  const connection = useMemo(() => new Connection(RPC, "confirmed"), []);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ pool: string; text: string; href?: string; ok?: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const [, setClock] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const list = await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/launches`).then((r) => r.json() as Promise<{ launches: Launch[] }>).catch(() => ({ launches: [] }));
      const withState = await Promise.all(list.launches.map(async (launch): Promise<Row> => {
        const view = await readPool(connection, launch.pool).catch(() => null);
        const stats = view ? await readLaunchStats(connection, { pool: launch.pool, baseMint: launch.baseMint, creator: view.creator, dammPool: view.dammPool }).catch(() => null) : null;
        return { ...launch, view, stats };
      }));
      if (!stopped) setRows(withState);
    };
    void load();
    const timer = setInterval(() => void load(), 12_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, refreshKey, tick]);
  // Ages tick every few seconds without refetching.
  useEffect(() => { const t = setInterval(() => setClock((n) => n + 1), 5_000); return () => clearInterval(t); }, []);

  /** Signs and sends one launch transaction with the trading account. */
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
      setNotice({ pool, text: `${label} · done`, href: explorer(signature, "tx"), ok: true });
      setTick((t) => t + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({ pool, text: `${label} failed: ${/insufficient/i.test(message) ? "not enough test USDC or SOL in your trading account (Start trading on the Trade page funds it)" : message}` });
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

  const byStage = (stage: Stage) => (rows ?? []).filter((row) => stageOf(row) === stage).sort((a, b) =>
    stage === "final" ? (b.view?.progress ?? 0) - (a.view?.progress ?? 0) : b.createdAt - a.createdAt);

  return (
    <section aria-label="Launches by stage" className="grid gap-3 lg:grid-cols-3">
      {COLUMNS.map((column) => (
        <PulseColumn key={column.stage} title={column.title} hint={column.hint} rows={rows === null ? null : byStage(column.stage)}>
          {(row) => (
            <PulseCard key={row.pool} row={row} stage={column.stage} quickBuyUsd={quickBuyUsd} busy={busy === row.pool}
              notice={notice?.pool === row.pool ? notice : null}
              onBuy={() => void act(row.pool, `Buying $${quickBuyUsd} of ${row.symbol}`, (owner) => buildSwapTransaction(connection, { owner, pool: new PublicKey(row.pool), side: "buy", amount: quickBuyUsd, slippageBps: 300 }))}
              onSell={() => void sellAll(row)}
              onGraduate={() => void act(row.pool, `Graduating ${row.symbol} to DAMM v2`, (payer) => buildGraduateTransaction(connection, { payer, pool: new PublicKey(row.pool) }))}
            />
          )}
        </PulseColumn>
      ))}
    </section>
  );
}

function PulseColumn({ title, hint, rows, children }: { title: string; hint: string; rows: Row[] | null; children: (row: Row) => React.ReactNode }) {
  const [query, setQuery] = useState("");
  const shown = rows?.filter((row) => `${row.symbol} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase())) ?? null;
  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)] lg:h-[calc(100vh-190px)] lg:min-h-[520px]">
      <div className="flex items-center gap-2 border-b border-[var(--t-border)] px-3 py-2.5">
        <h2 className="text-[15px] font-semibold text-[var(--t-text)]">{title}</h2>
        <span className="tnum rounded bg-[var(--t-surface-3)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--t-text-2)]">{rows?.length ?? "…"}</span>
        <label className="ml-auto flex h-7 w-[46%] items-center gap-1.5 rounded-full border border-[var(--t-border)] bg-[var(--t-bg)] px-2.5 text-[11.5px] text-[var(--t-text-3)]">
          <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by ticker or name" aria-label={`Search ${title}`} className="w-full bg-transparent text-[var(--t-text)] outline-none placeholder:text-[var(--t-text-3)]" />
        </label>
      </div>
      <p className="border-b border-[var(--t-border)] px-3 py-1 text-[10.5px] text-[var(--t-text-3)]">{hint}</p>
      <div className="slim-scroll min-h-0 flex-1 overflow-y-auto">
        {shown === null
          ? Array.from({ length: 3 }, (_, i) => <CardSkeleton key={i} />)
          : shown.length === 0
            ? <p className="px-4 py-10 text-center text-[12px] text-[var(--t-text-3)]">{query ? "No launch matches." : "Nothing here yet."}</p>
            : shown.map(children)}
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex animate-pulse gap-3 border-b border-[var(--t-border)] px-3 py-3">
      <span className="h-[60px] w-[60px] shrink-0 rounded-[8px] bg-[var(--t-surface-3)]" />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <span className="h-3 w-1/2 rounded bg-[var(--t-surface-3)]" />
        <span className="h-2.5 w-3/4 rounded bg-[var(--t-surface-3)]" />
        <span className="h-2 w-full rounded bg-[var(--t-surface-3)]" />
      </div>
    </div>
  );
}

const AVATAR_COLORS = ["#16a34a", "#2563eb", "#9333ea", "#db2777", "#ea580c", "#0891b2", "#ca8a04"];

/** Initials on a colour picked from the symbol (the create form's preview). */
export function TokenAvatar({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const hash = [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.38, background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}>
      {symbol.slice(0, 2)}
    </span>
  );
}

/** A token avatar: its metadata image, or initials on a colour derived from the mint. */
function CardAvatar({ row, stage }: { row: Row; stage: Stage }) {
  const hue = [...row.baseMint].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const ring = stage === "graduated" ? "ring-[var(--t-accent)]" : stage === "final" ? "ring-[var(--t-up)]" : "ring-[var(--t-border-strong)]";
  return (
    <div className="relative shrink-0">
      <div className={`h-[60px] w-[60px] overflow-hidden rounded-[8px] ring-2 ${ring}`} style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 60) % 360} 70% 40%))` }}>
        {row.stats?.image
          ? <img src={row.stats.image} alt="" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
          : <span className="grid h-full w-full place-items-center text-[16px] font-bold text-white">{row.symbol.slice(0, 2)}</span>}
      </div>
      <span className="mt-1 block w-[60px] truncate text-center text-[9.5px] text-[var(--t-text-3)]">{row.baseMint.slice(0, 4)}…{row.baseMint.slice(-4)}</span>
    </div>
  );
}

function Metric({ icon: Icon, value, title, tone }: { icon: typeof Users; value: string; title: string; tone?: "up" | "down" | "warn" }) {
  const color = tone === "up" ? "text-[var(--t-up)]" : tone === "down" ? "text-[var(--t-down)]" : tone === "warn" ? "text-[var(--t-warn)]" : "text-[var(--t-text-2)]";
  return <span title={title} className={`inline-flex items-center gap-1 ${color}`}><Icon className="h-3 w-3" aria-hidden /><span className="sr-only">{title}: </span>{value}</span>;
}

function PulseCard({ row, stage, quickBuyUsd, busy, notice, onBuy, onSell, onGraduate }: {
  row: Row; stage: Stage; quickBuyUsd: number; busy: boolean; notice: { text: string; href?: string; ok?: boolean } | null;
  onBuy: () => void; onSell: () => void; onGraduate: () => void;
}) {
  const { view, stats } = row;
  const perp = V3_MARKETS.find((market) => market.oracle.kind === "meteora" && market.oracle.mint === row.baseMint);
  const preset = LAUNCH_PRESETS.find((p) => p.id === row.preset);
  const ready = !!view && !view.graduated && view.progress >= 1;
  const [copied, setCopied] = useState(false);
  return (
    <article className="group border-b border-[var(--t-border)] px-3 py-3 transition-colors hover:bg-[var(--t-surface-3)]/40">
      <div className="flex gap-3">
        <CardAvatar row={row} stage={stage} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-semibold text-[var(--t-text)]">{row.symbol}</span>
            <span className="truncate text-[12.5px] text-[var(--t-text-3)]">{row.name}</span>
            <button type="button" aria-label={copied ? "Mint copied" : "Copy mint address"} title="Copy mint" onClick={() => navigator.clipboard.writeText(row.baseMint).then(() => setCopied(true), () => undefined)} className="text-[var(--t-text-3)] hover:text-[var(--t-text)]"><Copy className="h-3 w-3" /></button>
            <span className="ml-auto shrink-0 text-right text-[11px] text-[var(--t-text-3)]">MC <span className="tnum text-[13px] font-semibold text-[var(--t-text)]">{view ? formatCompactUsd(view.marketCap) : "—"}</span></span>
          </div>
          <div className="tnum mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
            <span className="font-semibold text-[var(--t-up)]" title="Age">{age(row.createdAt)}</span>
            <Metric icon={Users} value={stats ? String(stats.holders) : "—"} title="Holders" />
            <Metric icon={Crown} value={stats ? `${stats.top10Pct.toFixed(0)}%` : "—"} title="Top 10 holders' share of supply" tone={stats && stats.top10Pct > 30 ? "warn" : undefined} />
            <Metric icon={ChefHat} value={stats ? `${stats.devPct.toFixed(1)}%` : "—"} title="Creator's share of supply" tone={stats && stats.devPct > 10 ? "warn" : undefined} />
            <Metric icon={Clock} value={stats?.lastTradeAt ? age(stats.lastTradeAt) : "—"} title="Since the last transaction" />
            <span className="ml-auto text-[var(--t-text-3)]" title="Trading fees paid · transactions">F <span className="text-[var(--t-text)]">{view ? formatCompactUsd(view.feesUsd) : "—"}</span> · TX <span className="text-[var(--t-text)]">{stats ? `${stats.txns}${stats.txnsCapped ? "+" : ""}` : "—"}</span></span>
          </div>
          {view ? (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--t-surface-3)]" role="progressbar" aria-valuenow={Math.round(view.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Curve progress to graduation">
                <div className={`h-full rounded-full ${stage === "graduated" ? "bg-[var(--t-accent)]" : "bg-[var(--t-up)]"}`} style={{ width: `${Math.round(view.progress * 100)}%` }} />
              </div>
              <span className="tnum shrink-0 text-[10.5px] text-[var(--t-text-2)]">{stage === "graduated" ? "graduated" : `${(view.progress * 100).toFixed(0)}% · ${formatCompactUsd(view.raisedUsd)}/${formatCompactUsd(view.thresholdUsd)}`}</span>
            </div>
          ) : <p className="mt-2 text-[11px] text-[var(--t-text-3)]">Pool state unavailable.</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[72px] text-[11.5px]">
        <span className="rounded bg-[var(--t-surface-3)] px-1.5 py-0.5 text-[10px] text-[var(--t-text-2)]">{preset?.label ?? row.preset}</span>
        {view?.dammPool ? <a className="inline-flex items-center gap-0.5 text-[var(--t-link)] hover:underline" href={explorer(view.dammPool)} target="_blank" rel="noopener noreferrer">DAMM v2 <ExternalLink className="h-3 w-3" /></a> : null}
        {stage === "graduated" ? (perp
          ? <Link className="font-semibold text-[var(--t-up)] hover:underline" href={`/trade?market=${perp.symbol}`}>Trade {perp.symbol}</Link>
          : <span className="text-[var(--t-text-3)]">Perp listing queued</span>) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {view && !view.graduated && !ready ? (
            <>
              <button type="button" disabled={busy} onClick={onSell} className="rounded-full border border-[var(--t-border)] px-2.5 py-1 text-[var(--t-text-2)] hover:text-[var(--t-text)] disabled:opacity-50">Sell all</button>
              <button type="button" disabled={busy} onClick={onBuy} className="inline-flex items-center gap-1 rounded-full bg-[var(--t-up-3)] px-3 py-1 font-semibold text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)] disabled:opacity-50">
                <Zap className="h-3.5 w-3.5" aria-hidden /> ${quickBuyUsd}
              </button>
            </>
          ) : null}
          {ready ? <button type="button" disabled={busy} onClick={onGraduate} className="rounded-full bg-[var(--t-up-3)] px-3 py-1 font-semibold text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)] disabled:opacity-50">Graduate to DAMM v2</button> : null}
          <a className="text-[var(--t-text-3)] hover:text-[var(--t-text)]" href={explorer(row.pool)} target="_blank" rel="noopener noreferrer" aria-label={`${row.symbol} pool on the explorer`}><ExternalLink className="h-3.5 w-3.5" /></a>
        </span>
      </div>
      {notice ? (
        <p role="status" className={`mt-1.5 pl-[72px] text-[11.5px] ${notice.ok ? "text-[var(--t-up)]" : "text-[var(--t-text-2)]"}`}>{notice.text}{notice.href ? <> · <a className="text-[var(--t-link)] hover:underline" href={notice.href} target="_blank" rel="noreferrer">View ↗</a></> : null}</p>
      ) : null}
    </article>
  );
}
