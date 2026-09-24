"use client";

import type { OpenOrdersViewState } from "@/lib/open-orders";
import { useNewKeys } from "@/lib/use-new-keys";
import { marketPair } from "@/lib/v3-markets";

export interface OpenOrdersPanelProps {
  state: OpenOrdersViewState;
  onCancel: (orderKey: bigint) => void;
  onReplace: (orderKey: bigint) => void;
  onCancelAll: () => void;
  pending: boolean;
  symbol?: string;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const until = (unix: bigint) => {
  const s = Number(unix) - Math.floor(Date.now() / 1000);
  return s <= 0 ? "expiring" : s < 3600 ? `${Math.ceil(s / 60)}m left` : s < 86_400 ? `${Math.floor(s / 3600)}h left` : `${Math.floor(s / 86_400)}d left`;
};

/** Open orders as equal-height glass cards, newest on top; every adapter state
 * (loading, unavailable, error, empty, ready/stale) renders distinctly. */
export function OpenOrdersPanel({ state, onCancel, onReplace, onCancelAll, pending, symbol }: OpenOrdersPanelProps) {
  const orders = state.kind === "ready" ? [...state.orders].sort((a, b) => (b.orderKey > a.orderKey ? 1 : -1)) : [];
  const fresh = useNewKeys(orders.map((order) => order.orderKey.toString()));
  if (state.kind !== "ready") {
    const text = state.kind === "loading" ? "Loading open orders…" : state.kind === "unavailable" ? state.reason : state.kind === "error" ? state.message : "No open orders in this market.";
    return <p className={`flex h-full items-center justify-center px-4 text-center text-[12px] ${state.kind === "error" ? "text-[var(--t-down)]" : "text-[var(--t-text-2)]"}`}>{text}</p>;
  }
  return (
    <section aria-label="Open orders" className="space-y-1.5 p-2">
      <div className="flex items-center gap-2 px-1 text-[11px] text-[var(--t-text-3)]">
        <span><span className="tnum font-semibold text-[var(--t-text)]">{orders.length}</span> open {orders.length === 1 ? "order" : "orders"}</span>
        {state.stale ? <span className="text-[var(--t-warn)]">· last refresh failed, showing the last read</span> : null}
        <button type="button" disabled={pending} onClick={onCancelAll} className="ml-auto rounded-full border border-[var(--t-border)] px-2.5 py-0.5 text-[11px] text-[var(--t-text-2)] hover:text-[var(--t-down)] disabled:opacity-50">Cancel all</button>
      </div>
      {orders.map((order) => {
        const key = order.orderKey.toString();
        const long = order.side === "bid";
        // On-chain prices carry 5 decimals (Pyth exponent -5).
        const price = Number(order.price) / 1e5;
        const qty = Number(order.quantity);
        const filled = Number(order.filledQuantity);
        return (
          <article key={key} className={`glass-card relative h-[50px] overflow-hidden py-1.5 pl-3.5 pr-2 ${fresh.has(key) ? "card-enter" : ""}`}>
            <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${long ? "bg-[var(--t-up)]" : "bg-[var(--t-down)]"}`} />
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={`font-semibold ${long ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{long ? "Buy" : "Sell"}</span>
              <span className="truncate text-[var(--t-text)]">{symbol ? marketPair(symbol) : ""}</span>
              <span className="truncate text-[10.5px] text-[var(--t-text-3)]">{order.tree === "fixed" ? "Limit" : "Pegged"}{order.postOnly ? " · post-only" : ""}{order.reduceOnly ? " · reduce-only" : ""} · {order.expiresAt ? until(order.expiresAt) : "GTC"}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <button type="button" disabled={pending} onClick={() => onReplace(order.orderKey)} title="Replace with the ticket's side, size and price" className="h-6 rounded-full border border-[var(--t-border)] px-2 text-[11px] text-[var(--t-text-2)] hover:text-[var(--t-text)] disabled:opacity-50">Replace</button>
                <button type="button" disabled={pending} onClick={() => onCancel(order.orderKey)} className="h-6 rounded-full bg-[var(--t-down-soft)] px-2.5 text-[11px] font-semibold text-[var(--t-down)] hover:brightness-95 disabled:opacity-50">Cancel</button>
              </span>
            </div>
            <div className="tnum flex gap-4 text-[11.5px]">
              <span><span className="text-[var(--t-text-3)]">Price</span> {price.toFixed(2)}</span>
              <span><span className="text-[var(--t-text-3)]">Size</span> {qty}{filled ? ` · ${filled} filled` : ""}</span>
              <span><span className="text-[var(--t-text-3)]">Value</span> {usd(price * qty)}</span>
            </div>
          </article>
        );
      })}
    </section>
  );
}
