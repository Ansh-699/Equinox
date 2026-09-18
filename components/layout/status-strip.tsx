import { Clock3, Radio, ShieldCheck, TriangleAlert } from "lucide-react";
import { PERP_MARKETS } from "@/lib/markets";
import type { ExecutionDisplayState } from "@/lib/execution-status";

/** MagicBlock/session status is real, polled data (features/magicblock/
 * use-execution-status.ts) once a market API URL is configured; it shows
 * "unavailable" rather than fabricating a status when it isn't. Oracle
 * status stays a placeholder: the "oracle" market-event payload is a raw,
 * undecoded byte blob (see workers/src/event-decoder.ts) and this frontend
 * does not have a verified byte layout for it to decode safely -- showing
 * a made-up price/staleness read would be worse than showing nothing. */
export function ExecutionStatusBanner({ display, canTrade }: { display: ExecutionDisplayState | null; canTrade: boolean }) {
  const magicBlockLabel = !display
    ? "unavailable"
    : display.degraded
    ? "reconciliation error"
    : display.restorationPending
    ? "restoring"
    : display.commitPending
    ? "commit pending"
    : display.marketDelegated
    ? `ER active (seq ${display.lastErSequence})`
    : "not delegated";

  return (
    <section className="status-strip" aria-live="polite">
      <div><Radio size={15} /> <strong>{canTrade ? "Session trading enabled" : "Trading disabled"}</strong><span>{canTrade ? "Session-signed orders" : "Authenticated previews only"}</span></div>
      <div>{display?.degraded ? <TriangleAlert size={15} /> : <Clock3 size={15} />} MagicBlock <span>{magicBlockLabel}</span></div>
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
