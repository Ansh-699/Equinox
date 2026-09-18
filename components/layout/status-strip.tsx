import { Clock3, Radio, ShieldCheck } from "lucide-react";
import { PERP_MARKETS } from "@/lib/markets";

export function TradingDisabledBanner() {
  return (
    <section className="status-strip" aria-live="polite">
      <div><Radio size={15} /> <strong>Trading disabled</strong><span>Authenticated previews only</span></div>
      <div><Clock3 size={15} /> MagicBlock <span>not delegated</span></div>
      <div><ShieldCheck size={15} /> Oracle <span>not connected</span></div>
    </section>
  );
}

export function ProtocolStatusStrip({
  marketSymbol,
  onMarketSymbolChange,
  authenticated,
}: {
  marketSymbol: string;
  onMarketSymbolChange: (symbol: string) => void;
  authenticated: boolean;
}) {
  return (
    <section className="status-strip" aria-label="StockStream status">
      <label>
        Market
        <select value={marketSymbol} onChange={(event) => onMarketSymbolChange(event.target.value)}>
          {PERP_MARKETS.map((market) => (
            <option key={market.symbol} value={market.symbol}>{market.symbol} · {market.live ? "live" : "fixture"}</option>
          ))}
        </select>
      </label>
      <div><strong>Program</strong><span>local build available</span></div>
      <div><strong>Collateral</strong><span>test-only/not connected</span></div>
      <div><strong>Session</strong><span>{authenticated ? "authenticated" : "not authenticated"}</span></div>
    </section>
  );
}
