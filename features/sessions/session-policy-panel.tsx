"use client";

import { useState } from "react";
import { SESSION_ACTION, type SessionStatus } from "@/lib/session-trading";
import type { SessionConfigInput } from "./use-trading-session";

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
      <section className="session-panel">
        <div className="panel-title"><h2>Trading session</h2><span>{status.revoked ? "revoked" : "authorized"}</span></div>
        <dl className="session-detail">
          <dt>Session key</dt><dd>{status.sessionSignerAddress.slice(0, 6)}…{status.sessionSignerAddress.slice(-6)}</dd>
          <dt>Expires</dt><dd>{new Date(status.expiresAt * 1000).toLocaleString()} <span className="muted">(market clock)</span></dd>
          <dt>Max order notional</dt><dd>{status.maxOrderNotional}</dd>
          <dt>Max cumulative notional</dt><dd>{status.maxCumulativeNotional}</dd>
          <dt>Max open orders</dt><dd>{status.maximumOpenOrders}</dd>
        </dl>
        <button onClick={onRevoke} disabled={pending}>{pending ? "Revoking…" : "Revoke session"}</button>
        {error ? <p className="form-note">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="session-panel">
      <div className="panel-title"><h2>Authorize a trading session</h2><span>One main-wallet signature</span></div>
      <label>Expires in (minutes)<input type="number" min={5} max={1440} value={expiresInMinutes} onChange={(event) => setExpiresInMinutes(Number(event.target.value) || 60)} /></label>
      <label>Max order notional (base units)<input value={maxOrderNotional} onChange={(event) => setMaxOrderNotional(event.target.value)} inputMode="numeric" /></label>
      <label>Max cumulative notional (base units)<input value={maxCumulativeNotional} onChange={(event) => setMaxCumulativeNotional(event.target.value)} inputMode="numeric" /></label>
      <label>Max exposure (base units)<input value={maximumExposure} onChange={(event) => setMaximumExposure(event.target.value)} inputMode="numeric" /></label>
      <label>Max open orders<input type="number" min={1} max={256} value={maximumOpenOrders} onChange={(event) => setMaximumOpenOrders(Number(event.target.value) || 16)} /></label>
      <fieldset className="session-actions" aria-label="Allowed actions">
        <legend>Allowed actions</legend>
        {ACTION_LABELS.map(({ key, label }) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={(actions & SESSION_ACTION[key]) !== 0}
              onChange={() => setActions((current) => current ^ SESSION_ACTION[key])}
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>
      <button
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
      {error ? <p className="form-note">{error}</p> : null}
    </section>
  );
}
