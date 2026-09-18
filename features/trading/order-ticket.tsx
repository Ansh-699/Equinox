import { TrendingDown, TrendingUp } from "lucide-react";
import type { PerpMarketConfig } from "@/lib/markets";
import { formatUsd } from "./format";

export function OrderTicket({
  side,
  onSideChange,
  quantity,
  onQuantityChange,
  limitPrice,
  onLimitPriceChange,
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
      <label>Order type<select defaultValue="marketable-limit"><option value="marketable-limit">Marketable limit</option><option value="limit">Limit</option><option value="post-only">Post-only</option></select></label>
      <label>Size<input value={quantity} type="number" min="1" onChange={(event) => onQuantityChange(event.target.value)} /><span className="input-suffix">shares</span></label>
      <label>Limit price<input value={limitPrice} onChange={(event) => onLimitPriceChange(event.target.value)} placeholder={Number.isFinite(markPrice) ? markPrice.toFixed(2) : "Awaiting verified price"} inputMode="decimal" /><span className="input-suffix">USD</span></label>
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
