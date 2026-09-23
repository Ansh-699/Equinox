"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import deployment from "@/config/stockstream-deployment.json";
import { myErTxs, onErTx, type ErTxSample } from "@/lib/er-latency";
import { Spinner } from "@/components/ui/spinner";

const POLL_MS = 1_000;
const EMPTY: readonly ErTxSample[] = [];
const explorer = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(deployment.magicBlock.rpc)}`;
const LABEL: Record<string, string> = { quote: "Quote", replace: "Requote", cancel: "Cancel", take: "Taker fill" };

/** Live MagicBlock rollup transactions: the market maker's (from the Worker)
 * and this browser's own, each with its measured submit → confirmed time. */
export function ErTxPanel({ marketApiUrl }: { marketApiUrl: string | undefined }) {
  const [bots, setBots] = useState<ErTxSample[]>([]);
  const [bot, setBot] = useState<{ colo: string | null; pingMs: number | null } | null>(null);
  const mine = useSyncExternalStore(onErTx, myErTxs, () => EMPTY);

  useEffect(() => {
    if (!marketApiUrl) return;
    let stopped = false;
    const poll = () => fetch(`${marketApiUrl.replace(/\/$/, "")}/v1/mm/status`)
      .then((response) => (response.ok ? response.json() : null))
      .then((status: { recent?: ErTxSample[]; colo?: string | null; pingMs?: number | null } | null) => {
        if (stopped || !status?.recent) return;
        setBots(status.recent);
        setBot({ colo: status.colo ?? null, pingMs: status.pingMs ?? null });
      })
      .catch(() => undefined);
    void poll();
    const interval = setInterval(poll, POLL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [marketApiUrl]);

  const rows = [...mine, ...bots].sort((a, b) => b.at - a.at).slice(0, 40);
  const median = (list: readonly ErTxSample[]) => {
    const times = list.flatMap((row) => (row.ok && row.ms !== null ? [row.ms] : [])).sort((a, b) => a - b);
    return times.length ? times[Math.floor(times.length / 2)] : null;
  };
  const p50 = median(bots);
  const myP50 = median(mine);
  const myNet = mine.find((row) => row.netMs != null)?.netMs ?? null;
  const scale = 60;

  return (
    <section className="flex min-h-0 flex-col border-t border-[var(--t-border)] md:border-l" aria-label="Live rollup transactions">
      <div className="tk-head gap-2">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--t-up)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--t-up)]" />
        </span>
        <span className="text-[12px] font-medium text-[var(--t-text)]">MagicBlock ER · live txns</span>
        <span className="tnum ml-auto text-[11px] text-[var(--t-text-3)]" title="Send → the rollup's processed push, measured by the market-maker bot">p50 <span className="text-[var(--t-text)]">{p50 === null ? "—" : `${p50} ms`}</span></span>
      </div>
      <div className="tnum flex flex-wrap gap-x-3 border-b border-[var(--t-surface-2)] px-3 py-1 text-[10.5px] text-[var(--t-text-3)]">
        <span>Bot in {bot?.colo ?? "…"} · {bot?.pingMs ?? "—"} ms from the rollup (Singapore)</span>
        {myP50 !== null ? <span>You: {myP50} ms{myNet !== null ? ` · ${myNet} ms of it network` : ""}</span> : null}
      </div>
      <div className="slim-scroll h-[212px] overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-[12px] text-[var(--t-text-2)]"><Spinner /> Waiting for rollup transactions…</div>
        ) : (
          <ul className="divide-y divide-[var(--t-surface-2)]">
            {rows.map((row) => (
              <li key={row.signature} className={`tnum grid grid-cols-[52px_1fr_auto] items-center gap-2 px-3 py-[5px] text-[11.5px] ${row.mine ? "bg-[var(--t-surface-2)]" : ""}`}>
                <a href={explorer(row.signature)} target="_blank" rel="noreferrer" className="truncate text-[var(--t-text-3)] hover:text-[var(--t-text)]">
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
                    <span className="block h-full rounded bg-[var(--t-up)]" style={{ width: `${row.ms === null ? 0 : Math.min(100, (row.ms / scale) * 100)}%` }} />
                  </span>
                  <span className={`w-[52px] text-right ${row.ok ? "text-[var(--t-text)]" : "text-[var(--t-down)]"}`} title={row.netMs != null ? `${row.netMs} ms network round trip` : undefined}>{row.ok && row.ms !== null ? `${row.ms} ms` : "failed"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
