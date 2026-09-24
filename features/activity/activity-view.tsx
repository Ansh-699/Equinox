"use client";

import { useState } from "react";
import { ExternalLink, Receipt } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useLastSignature } from "@/lib/use-last-signature";
import { ACTIVITY_FILTERS, type ActivityFilterId } from "@/lib/activity-view-model";
import { ActivityFeed } from "@/features/account/activity-list";
import { Badge, Card, EmptyState, relativeTime, type Tone } from "@/components/ui/primitives";
import { useMarketEvents } from "./use-market-events";

const marketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL;
const STREAM_TONE: Record<string, Tone> = { live: "up", connecting: "muted", resynchronizing: "warn", unavailable: "down" };

export function ActivityView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_EQUINOX_MARKET_SYMBOL ?? "AAPL-PERP";
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const lastSignature = useLastSignature();
  const { events, status, gapCount, duplicateCount, lastGapAt } = useMarketEvents(marketApiUrl, marketSymbol);
  const [filter, setFilter] = useState<ActivityFilterId>("all");

  return (
    <div className="terminal min-h-screen">
      <TopBar active="activity" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <div className="mb-5">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--t-text)]">Activity</h1>
          <p className="mt-1 text-[13px] text-[var(--t-text-2)]">Everything happening on {marketSymbol}, live from the indexer, plus what you sent this session.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <Card
            className="min-w-0"
            title={<h2 className="text-[13px] font-semibold text-[var(--t-text)]">Recent market events</h2>}
            action={<Badge tone={STREAM_TONE[status] ?? "muted"} dot><span data-testid="market-events-status">{status}</span></Badge>}
            bodyClassName="px-4 pb-2 pt-3"
          >
            <div role="group" aria-label="Filter events" className="slim-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
              {ACTIVITY_FILTERS.map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                  className={`h-[28px] shrink-0 rounded-full border px-3 text-[12px] font-medium transition-colors ${filter === f.id ? "border-[var(--t-text)] bg-[var(--t-text)] text-[var(--t-bg)]" : "border-[var(--t-border-strong)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}>
                  {f.label}
                </button>
              ))}
            </div>
            {gapCount > 0 ? (
              <p className="mb-2 rounded-[8px] bg-[rgba(245,158,11,0.1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--t-warn)]">
                {gapCount} sequence gap{gapCount === 1 ? "" : "s"} detected on this connection
                {lastGapAt ? ` (most recent ${new Date(lastGapAt).toLocaleTimeString()})` : ""}. The missed events
                were never made up; a fresh snapshot was fetched to resynchronize instead.
                {duplicateCount > 0 ? ` ${duplicateCount} duplicate/out-of-order event(s) were also dropped.` : ""}
              </p>
            ) : duplicateCount > 0 ? (
              <p className="mb-2 text-[12px] text-[var(--t-text-3)]">{duplicateCount} duplicate/out-of-order event(s) dropped.</p>
            ) : null}
            <ActivityFeed events={events} filter={filter} emptyText={status === "unavailable" ? "The market event stream is unavailable right now." : filter === "all" ? "No events observed yet. They appear here as the market moves." : "No events of this type yet."} />
            <details className="mt-2 border-t border-[var(--t-border)] pt-2 text-[12px] text-[var(--t-text-2)]">
              <summary className="cursor-pointer py-1 font-medium text-[var(--t-text-2)] hover:text-[var(--t-text)]">How to read this</summary>
              <p className="mt-1 pb-2 leading-relaxed text-[var(--t-text-3)]">
                Each event shows its category (order book, trade, funding, market, oracle, custody) and the decoded event name, such as
                &quot;Order placed&quot;. When the event did not carry a name it says &quot;details unavailable&quot; instead of guessing.
                The event&apos;s payload body is not decoded yet: it has no verified byte layout in the event ABI. Rollup / L1 shows where
                the event happened, and #n is its sequence number.
              </p>
            </details>
          </Card>

          <div className="space-y-4">
            <Card title="Your transactions" action={<span className="text-[11px] text-[var(--t-text-3)]">this session</span>}>
              {lastSignature ? (
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--t-up-soft)] text-[var(--t-up)]"><Receipt className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium capitalize text-[var(--t-text)]">{lastSignature.instruction}</div>
                    <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--t-text-3)]">
                      <Badge tone="up">Sent</Badge>
                      <span>{lastSignature.domain === "er" ? "Rollup" : "Solana L1"}</span>·<span>{relativeTime(lastSignature.at)}</span>
                    </div>
                  </div>
                  {lastSignature.domain === "l1" ? (
                    <a href={`https://explorer.solana.com/tx/${lastSignature.signature}?cluster=devnet`} target="_blank" rel="noopener noreferrer" aria-label="View on Solana Explorer" className="text-[var(--t-link)]"><ExternalLink className="h-4 w-4" /></a>
                  ) : <span className="font-mono text-[11px] text-[var(--t-text-3)]" title={lastSignature.signature}>{lastSignature.signature.slice(0, 6)}…</span>}
                </div>
              ) : (
                <EmptyState icon={<Receipt className="h-5 w-5" />} title="No submitted transactions yet this session">Deposits, orders and withdrawals you send show up here.</EmptyState>
              )}
            </Card>

            <Card title="Rollup status" action={executionStatus?.commitPending ? <Badge tone="warn">commit pending</Badge> : null}>
              {executionStatus ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5">
                      {executionStatus.marketDelegated ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--t-up)] opacity-60" /> : null}
                      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${executionStatus.degraded ? "bg-[var(--t-down)]" : executionStatus.marketDelegated ? "bg-[var(--t-up)]" : "bg-[var(--t-warn)]"}`} />
                    </span>
                    <span className="text-[13.5px] font-semibold text-[var(--t-text)]">{executionStatus.degraded ? "Reconciliation error" : executionStatus.marketDelegated ? "Live on MagicBlock rollup" : "On Solana L1"}</span>
                  </div>
                  <p className="text-[12px] leading-relaxed text-[var(--t-text-2)]">
                    {executionStatus.marketDelegated ? "Orders match on the rollup in milliseconds; its state is committed back to Solana L1 in batches." : "The market runs directly on Solana L1 right now."}
                  </p>
                  <dl className="tnum grid grid-cols-2 gap-2">
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-3 py-2"><dt className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">Rollup seq</dt><dd className="text-[14px] font-semibold text-[var(--t-text)]">{executionStatus.lastErSequence.toLocaleString()}</dd></div>
                    <div className="rounded-[8px] bg-[var(--t-surface-2)] px-3 py-2"><dt className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--t-text-3)]">L1 committed</dt><dd className="text-[14px] font-semibold text-[var(--t-text)]">{executionStatus.lastCommittedL1Sequence.toLocaleString()}</dd></div>
                  </dl>
                </div>
              ) : (
                <p className="text-[12.5px] text-[var(--t-text-2)]">Execution status is unavailable right now.</p>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
