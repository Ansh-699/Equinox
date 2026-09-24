"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import deployment from "@/config/stockstream-deployment.json";
import { myErTxs, onErTx, type ErTxSample } from "@/lib/er-latency";
import { Spinner } from "@/components/ui/spinner";

/** Header facts and a backfill; the rows themselves arrive over the live stream. */
const POLL_MS = 5_000;
const MAX_ROWS = 60;
/** The market-maker VM's own HTTPS status URL (services/market-maker). Polled directly so a
 * tab left open does not spend Worker requests; the Worker's proxy is the fallback. */
const MM_STATUS_URL = process.env.NEXT_PUBLIC_MM_STATUS_URL || undefined;
const EMPTY: readonly ErTxSample[] = [];
export const rollupExplorer = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(deployment.magicBlock.rpc)}`;
const LABEL: Record<string, string> = { quote: "Quote", replace: "Requote", cancel: "Cancel", take: "Taker fill" };

/** Live MagicBlock rollup transactions: the market maker's (from the Worker)
 * and this browser's own, each with its measured submit → confirmed time. */
export function ErTxPanel({ marketApiUrl, market }: { marketApiUrl: string | undefined; market?: string }) {
  const [bots, setBots] = useState<ErTxSample[]>([]);
  const [bot, setBot] = useState<{ colo: string | null; pingMs: number | null; marketOpen: boolean | null; offline: boolean } | null>(null);
  const mine = useSyncExternalStore(onErTx, myErTxs, () => EMPTY);
  // This viewer's own round trip to the rollup (median of the last 5), measured live.
  const [viewerRtt, setViewerRtt] = useState<number | null>(null);
  useEffect(() => {
    const samples: number[] = [];
    let stopped = false;
    const ping = async () => {
      const started = performance.now();
      const ok = await fetch(deployment.magicBlock.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }).then((r) => r.ok).catch(() => false);
      if (!ok || stopped) return;
      samples.push(performance.now() - started);
      if (samples.length > 5) samples.shift();
      setViewerRtt(Math.round([...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]));
    };
    void ping();
    const timer = setInterval(() => void ping(), 3_000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!marketApiUrl && !MM_STATUS_URL) return;
    let stopped = false;
    const url = MM_STATUS_URL ?? `${(marketApiUrl ?? "").replace(/\/$/, "")}/v1/mm/status`;
    const poll = () => fetch(url)
      .then((response) => response.json())
      .then((status: { recent?: ErTxSample[]; colo?: string | null; pingMs?: number | null; marketOpen?: boolean | null } | null) => {
        if (stopped) return;
        // The service makes several markets: show this one's (rows without a market are TSLA's, from older builds).
        // Backfill without dropping rows the stream already delivered.
        const polled = (status?.recent ?? []).filter((row) => !market || (row.market ?? "TSLA-PERP") === market);
        setBots((current) => {
          const known = new Set(current.map((row) => row.signature));
          return [...current, ...polled.filter((row) => !known.has(row.signature))].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
        });
        setBot({ colo: status?.colo ?? null, pingMs: status?.pingMs ?? null, marketOpen: status?.marketOpen ?? null, offline: !status?.recent });
      })
      .catch(() => undefined);
    void poll();
    const interval = setInterval(poll, POLL_MS);
    // Live: each bot transaction arrives the moment the service sees it confirmed (server-sent events).
    const stream = MM_STATUS_URL ? new EventSource(MM_STATUS_URL.replace(/\/v1\/mm\/status$/, "/v1/mm/stream")) : null;
    stream?.addEventListener("tx", (event) => {
      const row = JSON.parse((event as MessageEvent<string>).data) as ErTxSample;
      if (market && (row.market ?? "TSLA-PERP") !== market) return;
      setBots((current) => (current.some((r) => r.signature === row.signature) ? current : [row, ...current].slice(0, MAX_ROWS)));
    });
    return () => { stopped = true; clearInterval(interval); stream?.close(); };
  }, [marketApiUrl, market]);

  const rows = [...mine, ...bots].sort((a, b) => b.at - a.at).slice(0, 40);
  const median = (list: readonly ErTxSample[], pick: (row: ErTxSample) => number | null) => {
    const times = list.flatMap((row) => { const value = row.ok ? pick(row) : null; return value === null ? [] : [value]; }).sort((a, b) => a - b);
    return times.length ? times[Math.floor(times.length / 2)] : null;
  };
  const total = (row: ErTxSample) => row.ms;
  const trip = median(bots, total), myTrip = median(mine, total);
  const scale = 100;

  return (
    <section className="flex min-h-0 flex-col border-t border-[var(--t-border)] md:border-l" aria-label="Live rollup transactions">
      <div className="tk-head gap-2">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--t-up)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--t-up)]" />
        </span>
        <span className="whitespace-nowrap text-[12px] font-medium text-[var(--t-text)]">MagicBlock ER · live</span>
        <span className="tnum ml-auto whitespace-nowrap text-[11px] text-[var(--t-text-3)]" title="Send → the MagicBlock rollup has executed it (not Solana L1 settlement), measured by whoever sent it">{myTrip !== null
          ? <>You p50 <span className="font-medium text-[var(--t-up)]">{myTrip} ms</span></>
          : <>From you ≈ <span className="font-medium text-[var(--t-up)]">{viewerRtt === null ? "—" : `${viewerRtt + (trip ?? 3)} ms`}</span></>}
          <span className="ml-2">rollup {trip ?? "—"} ms</span></span>
      </div>
      <div className="tnum flex flex-wrap gap-x-3 border-b border-[var(--t-surface-2)] px-3 py-1 text-[10.5px] text-[var(--t-text-3)]">
        <span>Rows: bot orders live from Singapore, 2 ms from MagicBlock&apos;s rollup: send → executed by the sequencer. &ldquo;From you&rdquo; = your measured round trip to the rollup + that execution: what your own order takes. Solana L1 settlement follows at each commit (every 30 min).</span>
      </div>
      <div className="slim-scroll h-[212px] overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-[12px] text-[var(--t-text-2)]">
            {bot?.offline ? "Market maker offline — no bot transactions to show." : bot?.marketOpen === false ? "US market closed — the bot is idle until the session reopens." : <><Spinner /> Waiting for rollup transactions…</>}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--t-surface-2)]">
            {rows.map((row) => (
              <li key={row.signature} className={`tnum grid grid-cols-[52px_1fr_auto] items-center gap-2 px-3 py-[5px] text-[11.5px] ${row.mine ? "bg-[var(--t-surface-2)]" : ""}`}>
                <a href={rollupExplorer(row.signature)} target="_blank" rel="noreferrer" className="truncate text-[var(--t-text-3)] hover:text-[var(--t-text)]">
                  {new Date(row.at).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
                </a>
                <span className="min-w-0 truncate">
                  <span className={row.mine ? "font-medium text-[var(--t-accent,var(--t-text))]" : "text-[var(--t-text-2)]"}>{row.mine ? `You · ${row.kind}` : LABEL[row.kind] ?? row.kind}</span>
                  {row.side && row.price !== undefined ? (
                    <span className={`ml-1.5 ${row.side === "bid" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{row.side === "bid" ? "B" : "S"} {row.quantity} @ {row.price.toFixed(2)}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="hidden h-[3px] w-10 overflow-hidden rounded bg-[var(--t-surface-3)] sm:block">
                    <span className="block h-full rounded bg-[var(--t-up)]" style={{ width: `${Math.min(100, ((row.ms ?? 0) / scale) * 100)}%` }} />
                  </span>
                  <span className={`w-[60px] text-right ${row.ok ? "text-[var(--t-text)]" : "text-[var(--t-down)]"}`} title="send → finalized in the rollup, as seen by the sender">
                    {row.ok && row.ms !== null ? `${row.ms} ms` : "failed"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
