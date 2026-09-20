"use client";

import type { OpenOrdersViewState } from "@/lib/open-orders";

export interface OpenOrdersPanelProps {
  state: OpenOrdersViewState;
  onCancel: (orderKey: bigint) => void;
  onReplace: (orderKey: bigint) => void;
  onCancelAll: () => void;
  pending: boolean;
}

/** Open-orders UI shell: every state the underlying adapter can report
 * (loading/unavailable/error/empty/ready+stale) gets a distinct, honest
 * rendering -- there is no "loading forever" or silently-blank table.
 * Cancel/Replace/Cancel-all call straight into the same session-signed
 * action functions the manual order-key form already uses
 * (features/sessions/use-session-order.ts). When the V3 aggregate is not
 * configured, the selected fallback adapter reports that honestly instead of
 * fabricating rows. */
export function OpenOrdersPanel({ state, onCancel, onReplace, onCancelAll, pending }: OpenOrdersPanelProps) {
  return (
    <section className="session-panel open-orders-panel">
      <div className="panel-title">
        <h2>Open orders</h2>
        <span>{state.kind === "ready" && state.stale ? "stale" : state.kind}</span>
      </div>

      {state.kind === "loading" ? <p className="form-note">Loading open orders…</p> : null}

      {state.kind === "unavailable" ? <p className="form-note">{state.reason}</p> : null}

      {state.kind === "error" ? <p className="form-note negative">{state.message}</p> : null}

      {state.kind === "empty" ? <p className="form-note">No open orders for this seat.</p> : null}

      {state.kind === "ready" ? (
        <>
          {state.stale ? <p className="form-note negative">Showing the last successfully loaded orders -- the most recent refresh failed.</p> : null}
          <div className="open-orders-table-wrap">
            <table className="activity-table open-orders-table">
              <thead>
                <tr>
                  <th>Side</th><th>Tree</th><th>Price</th><th>Qty</th><th>Filled</th><th>Flags</th><th>Expires</th><th aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {state.orders.map((order) => (
                  <tr key={order.orderKey.toString()} className="open-orders-row">
                    <td data-label="Side"><span className={order.side === "bid" ? "positive" : "negative"}>{order.side === "bid" ? "Long" : "Short"}</span></td>
                    <td data-label="Tree">{order.tree}</td>
                    <td data-label="Price">{order.price.toString()}</td>
                    <td data-label="Qty">{order.quantity.toString()}</td>
                    <td data-label="Filled">{order.filledQuantity.toString()}</td>
                    <td data-label="Flags">{[order.postOnly ? "post-only" : null, order.reduceOnly ? "reduce-only" : null].filter(Boolean).join(", ") || "--"}</td>
                    <td data-label="Expires">{order.expiresAt ? new Date(Number(order.expiresAt) * 1000).toLocaleString() : "GTC"}</td>
                    <td data-label="Actions" className="open-orders-actions">
                      <button disabled={pending} onClick={() => onReplace(order.orderKey)}>Replace</button>
                      <button disabled={pending} onClick={() => onCancel(order.orderKey)}>Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button disabled={pending} onClick={onCancelAll}>Cancel all</button>
        </>
      ) : null}
    </section>
  );
}
