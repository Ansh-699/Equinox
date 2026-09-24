"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ExecutionDisplayState } from "@/lib/execution-status";
import { publicMarketApiUrl } from "@/lib/demo-config";

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS;

type Health = "ok" | "warn" | "down";
const DOT: Record<Health, string> = { ok: "bg-[var(--t-up)]", warn: "bg-[var(--t-warn)]", down: "bg-[var(--t-down)]" };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${label}`} title="Copy"
      onClick={() => void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
      className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--t-text-3)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--t-up)]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Each service the app depends on, with a health dot and its value. */
export function NetworkList({ execution }: { execution: ExecutionDisplayState | null }) {
  const rows: { label: string; value: string; health: Health; copy?: string; note?: string }[] = [
    { label: "Solana RPC", value: RPC_URL ?? "Public devnet endpoint", health: "ok", copy: RPC_URL },
    { label: "Market API", value: publicMarketApiUrl, health: execution ? "ok" : "warn", copy: publicMarketApiUrl, note: execution ? undefined : "Not answering right now" },
    { label: "Session relayer", value: RELAYER_ADDRESS ? `${RELAYER_ADDRESS.slice(0, 4)}…${RELAYER_ADDRESS.slice(-4)}` : "Not configured", health: RELAYER_ADDRESS ? "ok" : "warn", copy: RELAYER_ADDRESS, note: RELAYER_ADDRESS ? undefined : "Session-key trading is off; the trading account still works" },
    {
      label: "MagicBlock rollup",
      value: execution === null ? "Unavailable" : execution.degraded ? "Reconciliation error" : execution.commitPending ? "Committing to L1" : execution.marketDelegated ? "Active" : "Market on L1",
      health: execution === null || execution.degraded ? "down" : execution.marketDelegated ? "ok" : "warn",
    },
  ];
  return (
    <ul className="divide-y divide-[var(--t-border)]">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center gap-3 py-2.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[row.health]}`} aria-label={row.health === "ok" ? "healthy" : row.health === "warn" ? "degraded" : "down"} role="img" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-[var(--t-text)]">{row.label}</div>
            {row.note ? <div className="text-[11px] text-[var(--t-text-3)]">{row.note}</div> : null}
          </div>
          <span className="max-w-[55%] truncate font-mono text-[11.5px] text-[var(--t-text-2)]" title={row.value}>{row.value}</span>
          {row.copy ? <CopyButton value={row.copy} label={row.label} /> : <span className="w-6" />}
        </li>
      ))}
    </ul>
  );
}
