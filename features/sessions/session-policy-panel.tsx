"use client";

import { useState } from "react";
import { SESSION_ACTION, type SessionStatus } from "@/lib/session-trading";
import type { SessionConfigInput } from "./use-trading-session";
import { HINT, PanelHead, SECONDARY_BTN, primaryBtn } from "@/features/trading/lifecycle-panel";

const FIELD = "flex flex-col gap-1 text-[11.5px] text-[var(--t-text-2)]";
const INPUT = "tnum h-[30px] rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-bg)] px-2 text-[12px] text-[var(--t-text)]";

const ACTION_LABELS: readonly { key: Exclude<keyof typeof SESSION_ACTION, "all">; label: string }[] = [
  { key: "place", label: "Place" },
  { key: "cancel", label: "Cancel" },
  { key: "cancelAll", label: "Cancel all" },
  { key: "replace", label: "Replace" },
  { key: "reduceOnlyClose", label: "Reduce-only close" },
];

export function SessionPolicyPanel({
  status,
  pending,
  error,
  onAuthorize,
  onRevoke,
}: {
  status: SessionStatus | null;
  pending: boolean;
  error: string | null;
  onAuthorize: (config: SessionConfigInput) => void;
  onRevoke: () => void;
}) {
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);
  const [maxOrderNotional, setMaxOrderNotional] = useState("1000000000");
  const [maxCumulativeNotional, setMaxCumulativeNotional] = useState("10000000000");
  const [maximumExposure, setMaximumExposure] = useState("5000000000");
  const [maximumOpenOrders, setMaximumOpenOrders] = useState(16);
  const [actions, setActions] = useState<number>(SESSION_ACTION.all);

  if (status) {
    return (
      <section aria-label="Trading session">
        <PanelHead title="Session key" badge={status.revoked ? "revoked" : "active"} tone={status.revoked ? "muted" : "ok"} />
        <div className="space-y-2 p-3">
          <div className="rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-[10px] py-2 text-[12px]">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-[var(--t-text-3)]">Key</dt><dd className="tnum text-right font-mono text-[var(--t-text)]">{status.sessionSignerAddress.slice(0, 6)}…{status.sessionSignerAddress.slice(-6)}</dd>
              <dt className="text-[var(--t-text-3)]">Expires</dt><dd className="tnum text-right text-[var(--t-text)]">{new Date(status.expiresAt * 1000).toLocaleString()}</dd>
              <dt className="text-[var(--t-text-3)]">Max order</dt><dd className="tnum text-right text-[var(--t-text)]">{status.maxOrderNotional}</dd>
              <dt className="text-[var(--t-text-3)]">Max cumulative</dt><dd className="tnum text-right text-[var(--t-text)]">{status.maxCumulativeNotional}</dd>
              <dt className="text-[var(--t-text-3)]">Max open orders</dt><dd className="tnum text-right text-[var(--t-text)]">{status.maximumOpenOrders}</dd>
            </dl>
          </div>
          <button type="button" className={`w-full ${SECONDARY_BTN}`} onClick={onRevoke} disabled={pending}>{pending ? "Revoking…" : "Revoke session"}</button>
          <p className={HINT}>Orders sign locally with the session key — no wallet popup. It can never withdraw.</p>
          {error ? <p className="text-[11.5px] text-[var(--t-down)]">{error}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Trading session">
      <PanelHead title="Session key" badge="off" />
      <div className="space-y-2 p-3">
        <p className="text-[11.5px] leading-relaxed text-[var(--t-text-2)]">One wallet approval mints a scoped, expiring key for placing and cancelling orders. It cannot withdraw collateral.</p>
        <details className="rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 py-2 text-[12px]">
          <summary className="cursor-pointer text-[var(--t-text-2)] hover:text-[var(--t-text)]">Limits</summary>
          <div className="mt-2 grid gap-2">
            <label className={FIELD}>Expires in (minutes)<input className={INPUT} type="number" min={5} max={1440} value={expiresInMinutes} onChange={(event) => setExpiresInMinutes(Number(event.target.value) || 60)} /></label>
            <label className={FIELD}>Max order notional (base units)<input className={INPUT} value={maxOrderNotional} onChange={(event) => setMaxOrderNotional(event.target.value)} inputMode="numeric" /></label>
            <label className={FIELD}>Max cumulative notional (base units)<input className={INPUT} value={maxCumulativeNotional} onChange={(event) => setMaxCumulativeNotional(event.target.value)} inputMode="numeric" /></label>
            <label className={FIELD}>Max exposure (base units)<input className={INPUT} value={maximumExposure} onChange={(event) => setMaximumExposure(event.target.value)} inputMode="numeric" /></label>
            <label className={FIELD}>Max open orders<input className={INPUT} type="number" min={1} max={256} value={maximumOpenOrders} onChange={(event) => setMaximumOpenOrders(Number(event.target.value) || 16)} /></label>
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Allowed actions">
              <legend className="mb-1 text-[11.5px] text-[var(--t-text-2)]">Allowed actions</legend>
              {ACTION_LABELS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-[11.5px] text-[var(--t-text-2)]">
                  <input type="checkbox" className="accent-[var(--t-up)]" checked={(actions & SESSION_ACTION[key]) !== 0} onChange={() => setActions((current) => current ^ SESSION_ACTION[key])} />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
        </details>
        <button
          type="button"
          className={primaryBtn(pending)}
          disabled={pending}
          onClick={() =>
            onAuthorize({
              expiresInMinutes,
              maxOrderNotional: BigInt(maxOrderNotional || "0"),
              maxCumulativeNotional: BigInt(maxCumulativeNotional || "0"),
              maximumExposure: BigInt(maximumExposure || "0"),
              maximumOpenOrders,
              actions,
            })
          }
        >
          {pending ? "Authorizing…" : "Authorize session"}
        </button>
        {error ? <p className="text-[11.5px] text-[var(--t-down)]">{error}</p> : null}
      </div>
    </section>
  );
}
