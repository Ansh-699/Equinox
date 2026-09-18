import { TrendingDown, TrendingUp } from "lucide-react";
import type { PerpMarketConfig } from "@/lib/markets";
import { formatUsd } from "./format";

export type OrderTypeOption = "limit" | "post-only" | "ioc" | "oracle-pegged";

export function OrderTicket({
  side,
  onSideChange,
  quantity,
  onQuantityChange,
  limitPrice,
  onLimitPriceChange,
  orderType,
  onOrderTypeChange,
  reduceOnly,
  onReduceOnlyChange,
  expiresInMinutes,
  onExpiresInMinutesChange,
  markPrice,
  notional,
  authenticated,
  canTrade,
  marketConfig,
  onSubmit,
}: {
  side: "short" | "long";
  onSideChange: (side: "short" | "long") => void;
  quantity: string;
  onQuantityChange: (value: string) => void;
  limitPrice: string;
  onLimitPriceChange: (value: string) => void;
  orderType: OrderTypeOption;
  onOrderTypeChange: (value: OrderTypeOption) => void;
  reduceOnly: boolean;
  onReduceOnlyChange: (value: boolean) => void;
  expiresInMinutes: string;
  onExpiresInMinutesChange: (value: string) => void;
  markPrice: number;
  notional: number;
  authenticated: boolean;
  canTrade: boolean;
  marketConfig: PerpMarketConfig;
  onSubmit: () => void;
}) {
  return (
    <aside className="order-panel">
      <div className="panel-title"><h2>Place order</h2><span>Isolated margin</span></div>
      <div className="side-toggle" role="group" aria-label="Order direction">
        <button className={side === "long" ? "long active-side" : "long"} onClick={() => onSideChange("long")}><TrendingUp size={16} /> Long</button>
        <button className={side === "short" ? "short active-side" : "short"} onClick={() => onSideChange("short")}><TrendingDown size={16} /> Short</button>
      </div>
      <label>
        Order type
        <select value={orderType} onChange={(event) => onOrderTypeChange(event.target.value as OrderTypeOption)}>
          <option value="limit">Limit (fixed price, GTC)</option>
          <option value="post-only">Post-only (fixed price)</option>
          <option value="ioc">IOC (fixed price, aggressive-limit)</option>
          <option value="oracle-pegged">Oracle-pegged (offset from index)</option>
        </select>
      </label>
      <label>Size<input value={quantity} type="number" min="1" onChange={(event) => onQuantityChange(event.target.value)} /><span className="input-suffix">shares</span></label>
      <label>{orderType === "oracle-pegged" ? "Oracle offset" : "Limit price"}<input value={limitPrice} onChange={(event) => onLimitPriceChange(event.target.value)} placeholder={orderType === "oracle-pegged" ? "0.00" : Number.isFinite(markPrice) ? markPrice.toFixed(2) : "Awaiting verified price"} inputMode="decimal" /><span className="input-suffix">USD</span></label>
      <label>Expires in (minutes, 0 = GTC)<input value={expiresInMinutes} onChange={(event) => onExpiresInMinutesChange(event.target.value)} type="number" min="0" inputMode="numeric" /></label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, flexDirection: "row" }}>
        <input type="checkbox" checked={reduceOnly} onChange={(event) => onReduceOnlyChange(event.target.checked)} /> Reduce-only
      </label>
      <div className="order-review">
        <span>Estimated notional</span><strong>{Number.isFinite(notional) ? formatUsd(notional) : "--"}</strong>
        <span>Initial margin</span><strong>{Number.isFinite(notional) ? formatUsd(notional * 0.2) : "--"}</strong>
        <span>Est. liquidation</span><strong>Calculated on-chain</strong>
      </div>
      <button className={side === "short" ? "submit short-submit" : "submit long-submit"} onClick={onSubmit}>{canTrade ? "Place order" : authenticated ? "Preview order" : "Sign in to preview"}</button>
      <p className="form-note">{canTrade ? `Session-signed: ${marketConfig.symbol}.` : `Session scope: ${marketConfig.symbol}.`} Withdrawals and collateral transfers are excluded.</p>
    </aside>
  );
}
