import { Clock3, Radio, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { PERP_MARKETS } from "@/lib/markets";
import type { ExecutionDisplayState } from "@/lib/execution-status";
import type { OracleSafetyState } from "@/lib/oracle-safety";

const ORACLE_SAFETY_LABEL: Record<OracleSafetyState, string> = {
  fresh: "fresh",
  stale: "stale",
  closed: "closed",
  halted: "halted",
  corp_action: "corporate action",
  unknown: "unavailable",
};

/** MagicBlock/session status is real, polled data (features/magicblock/
 * use-execution-status.ts) once a market API URL is configured; it shows
 * "unavailable" rather than fabricating a status when it isn't. Oracle
 * status (lib/oracle-safety.ts) is built ONLY from the already-verified
 * account header fields (oracleValid/lastVerifiedOracleTimestamp) and
 * fully-decoded market-event KIND NAMES -- the event's own 48-byte
 * category-specific payload body stays undecoded, since there is no
 * verified byte layout for it. */
export function ExecutionStatusBanner({ display, canTrade, oracleSafety }: { display: ExecutionDisplayState | null; canTrade: boolean; oracleSafety: OracleSafetyState }) {
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
  const oracleSafe = oracleSafety === "fresh";

  return (
    <section className="status-strip" aria-live="polite">
      <div><Radio size={15} /> <strong>{canTrade ? "Session trading enabled" : "Trading disabled"}</strong><span>{canTrade ? "Session-signed orders" : "Authenticated previews only"}</span></div>
      <div>{display?.degraded ? <TriangleAlert size={15} /> : <Clock3 size={15} />} MagicBlock <span>{magicBlockLabel}</span></div>
      <div>{oracleSafe ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />} Oracle <span>{ORACLE_SAFETY_LABEL[oracleSafety]}</span></div>
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
