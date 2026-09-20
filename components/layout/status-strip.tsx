import { Clock3, Radio, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { PERP_MARKETS } from "@/lib/markets";
import { describeExecutionStatus, type ExecutionDisplayState } from "@/lib/execution-status";
import { ORACLE_SAFETY_LABEL, type OracleSafetyState } from "@/lib/oracle-safety";
import type { V3MarketReadiness } from "@/features/magicblock/use-v3-market-state";

/** MagicBlock/session status is real, polled data (features/magicblock/
 * use-execution-status.ts) once a market API URL is configured; it shows
 * "unavailable" rather than fabricating a status when it isn't. Oracle
 * status (lib/oracle-safety.ts) is built ONLY from the already-verified
 * account header fields (oracleValid/lastVerifiedOracleTimestamp) and
 * fully-decoded market-event KIND NAMES -- the event's own 48-byte
 * category-specific payload body stays undecoded, since there is no
 * verified byte layout for it. */
export function ExecutionStatusBanner({ display, canTrade, oracleSafety }: { display: ExecutionDisplayState | null; canTrade: boolean; oracleSafety: OracleSafetyState }) {
  const magicBlockLabel = describeExecutionStatus(display);
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
  v3,
}: {
  marketSymbol: string;
  onMarketSymbolChange: (symbol: string) => void;
  authenticated: boolean;
  v3: V3MarketReadiness;
}) {
  const v3Label = v3.state === "available" ? (v3.withdrawalReady ? "withdrawal ready" : "execution state incomplete") : v3.state.replace("_", " ");
  const commitLabel = v3.state === "available" && v3.expectedCommitSequence !== null && v3.lastCommittedSequence !== null
    ? `commit ${v3.lastCommittedSequence.toString()}/${v3.expectedCommitSequence.toString()}` : "commit unavailable";
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
      <div><strong>V3 bundle</strong><span>{v3Label}</span></div>
      <div><strong>V3 shards</strong><span>{v3.bookPageCount} pages · {v3.seatShardCount} seats · {v3.eventShardCount} events</span></div>
      <div><strong>V3 finality</strong><span>{commitLabel}{v3.delegationStatus === null ? " · status unavailable" : ` · delegation ${v3.delegationStatus}`}</span></div>
    </section>
  );
}
