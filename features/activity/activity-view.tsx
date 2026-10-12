"use client";

import { useState, useSyncExternalStore } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useAccountSummary } from "@/features/portfolio/use-account-summary";
import { rollupExplorer } from "@/features/trading/er-tx-panel";
import { myErTxs, onErTx, type ErTxSample } from "@/lib/er-latency";
import { V3_MARKETS, marketBase } from "@/lib/v3-markets";
import { Badge, Card, EmptyState, type Tone } from "@/components/ui/primitives";
import { Receipt } from "lucide-react";
import { FillsList } from "./fills-list";
import { useRecentFills } from "./use-recent-fills";

const marketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL;
const STATUS_TONE: Record<string, Tone> = { live: "up", loading: "muted", unavailable: "down" };
const EMPTY: readonly ErTxSample[] = [];
const TIME = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const FILTERS = [{ id: "all", label: "All markets" }, ...V3_MARKETS.map((m) => ({ id: m.symbol, label: marketBase(m.symbol) })), { id: "mine", label: "Mine" }] as const;

export function ActivityView() {
  const auth = useAppAuth();
  const { fills, status } = useRecentFills();
  const summary = useAccountSummary(auth.walletAddress);
  const execution = useExecutionStatus(marketApiUrl, "TSLA-PERP");
  const mine = useSyncExternalStore(onErTx, myErTxs, () => EMPTY);
  const [filter, setFilter] = useState<string>("all");
  const mySeats = Object.fromEntries(Object.entries(summary.seats ?? {}).flatMap(([symbol, seat]) => (seat ? [[symbol, seat.index]] : [])));
  const shown = fills.filter((f) => filter === "all" || f.market === filter || (filter === "mine" && mySeats[f.market] !== undefined && (f.makerSeat === mySeats[f.market] || f.takerSeat === mySeats[f.market])));

  return (
    <div className="terminal min-h-screen">
      <TopBar active="activity" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <div className="mb-5">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--t-text)]">Activity</h1>
          <p className="mt-1 text-[13px] text-[var(--t-text-2)]">Recent fills across all four markets, read live from the MagicBlock rollup, plus what you sent this session.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <Card className="min-w-0" title={<h2 className="text-[13px] font-semibold text-[var(--t-text)]">Recent fills</h2>}
            action={<Badge tone={STATUS_TONE[status] ?? "muted"} dot>{status}</Badge>} bodyClassName="px-4 pb-2 pt-3">
            <div role="group" aria-label="Filter fills" className="slim-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                  className={`h-[28px] shrink-0 rounded-full border px-3 text-[12px] font-medium transition-colors ${filter === f.id ? "border-[var(--t-text)] bg-[var(--t-text)] text-[var(--t-bg)]" : "border-[var(--t-border-strong)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <FillsList fills={shown} mySeats={mySeats} limit={60}
              empty={status === "unavailable" ? "The rollup is unreachable right now; retrying." : filter === "mine" ? "None of your orders filled yet (fills are read from the rollup's recent fill records)." : "Waiting for fills…"} />
          </Card>

          <div className="space-y-4">
            <Card title="Your rollup transactions" action={<span className="text-[11px] text-[var(--t-text-3)]">this session</span>}>
              {mine.length ? (
                <ol className="tnum space-y-2 text-[12.5px]">
                  {mine.slice(0, 12).map((tx) => (
                    <li key={tx.signature} className="flex items-center gap-2">
                      <span className="text-[var(--t-text-3)]">{TIME.format(tx.at)}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--t-text)]" style={{ fontFamily: "var(--font-ui)" }}>{tx.kind}</span>
                      <span className={tx.ok ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}>{tx.ms ?? "—"} ms</span>
                      <a href={rollupExplorer(tx.signature)} target="_blank" rel="noopener noreferrer" className="text-[var(--t-link)] hover:underline">↗</a>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState icon={<Receipt className="h-5 w-5" />} title="Nothing sent yet this session">Orders, deposits and withdrawals you send from the terminal show up here with their rollup time.</EmptyState>
              )}
            </Card>

            <Card title="Rollup status" action={execution?.commitPending ? <Badge tone="warn">commit pending</Badge> : null}>
              {execution ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5">
                      {execution.marketDelegated ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--t-up)] opacity-60" /> : null}
                      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${execution.degraded ? "bg-[var(--t-down)]" : execution.marketDelegated ? "bg-[var(--t-up)]" : "bg-[var(--t-warn)]"}`} />
                    </span>
                    <span className="text-[13.5px] font-semibold text-[var(--t-text)]">{execution.degraded ? "Reconciliation error" : execution.marketDelegated ? "Live on MagicBlock rollup" : "On Solana L1"}</span>
                  </div>
                  <p className="text-[12px] leading-relaxed text-[var(--t-text-2)]">{execution.marketDelegated ? "Orders match in the rollup in milliseconds; state commits back to Solana in batches." : "This market is running on Solana L1."}</p>
                  <dl className="tnum grid grid-cols-2 gap-2">
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-3 py-2"><dt className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Rollup seq</dt><dd className="text-[14px] font-semibold text-[var(--t-text)]">{execution.lastErSequence.toLocaleString()}</dd></div>
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-3 py-2"><dt className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">L1 committed</dt><dd className="text-[14px] font-semibold text-[var(--t-text)]">{execution.lastCommittedL1Sequence.toLocaleString()}</dd></div>
                  </dl>
                </div>
              ) : (
                <p className="text-[12.5px] text-[var(--t-text-2)]">Checking execution status. If it stays unavailable, retry from the Trade page.</p>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
