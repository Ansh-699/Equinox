import { describeExecutionStatus, type ExecutionDisplayState } from "@/lib/execution-status";
import { ORACLE_SAFETY_LABEL, type OracleSafetyState } from "@/lib/oracle-safety";
import type { V3MarketReadiness } from "@/features/magicblock/use-v3-market-state";

type Level = "ok" | "warn" | "down";
const DOT: Record<Level, string> = { ok: "bg-[var(--t-up)]", warn: "bg-[var(--t-warn)]", down: "bg-[var(--t-down)]" };

function Row({ label, level, detail }: { label: string; level: Level; detail: string }) {
  return (
    <div className="flex h-[26px] items-center justify-between gap-3 border-b border-[var(--t-surface-2)] last:border-b-0">
      <span className="shrink-0 text-[12px] text-[var(--t-text-2)]">{label}</span>
      <span className="tnum inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--t-text)]">
        <span className="truncate">{detail}</span>
        <span className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${DOT[level]}`} />
      </span>
    </div>
  );
}

/** System status (SlipStream StatusPanel). MagicBlock status is the market
 * API's polled, authoritative state (features/magicblock/use-execution-status.ts);
 * oracle status is built only from verified snapshot fields (lib/oracle-safety.ts).
 * Nothing here is fabricated: an unknown reads as unknown. */
export function ExecutionStatusBanner({
  display,
  canTrade,
  walletTrading = false,
  oracleSafety,
  v3,
  privy,
}: {
  display: ExecutionDisplayState | null;
  canTrade: boolean;
  walletTrading?: boolean;
  oracleSafety: OracleSafetyState;
  v3?: V3MarketReadiness;
  /** Privy login + wallet behind the signer, for display. */
  privy?: string;
}) {
  const magicBlockLabel = describeExecutionStatus(display);
  const commit = v3?.state === "available" && v3.lastCommittedSequence !== null && v3.expectedCommitSequence !== null
    ? `${v3.lastCommittedSequence}/${v3.expectedCommitSequence}` : null;
  return (
    <section aria-label="System status">
      <div className="flex h-[36px] items-center justify-between border-b border-[var(--t-border)] px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--t-text-2)]">System status</h2>
        <span className="text-[11px] text-[var(--t-text-3)]">Verifiable on-chain</span>
      </div>
      <div className="status-strip p-3" aria-live="polite">
        <Row
          label="Trading"
          level={canTrade || walletTrading ? "ok" : "warn"}
          detail={canTrade ? "Session trading enabled · session-signed" : walletTrading ? "Trading enabled · wallet-signed" : "Trading disabled · previews only"}
        />
        {privy ? <Row label="Privy" level={privy === "not signed in" || privy === "sign-in incomplete" ? "warn" : "ok"} detail={privy} /> : null}
        <Row label="MagicBlock" level={!display ? "down" : display.degraded ? "warn" : "ok"} detail={magicBlockLabel} />
        <Row label="Pyth oracle" level={oracleSafety === "fresh" ? "ok" : oracleSafety === "unknown" ? "warn" : "down"} detail={ORACLE_SAFETY_LABEL[oracleSafety]} />
        <Row label="Order routing" level={display?.orderRoutingDomain ? "ok" : "warn"} detail={display?.orderRoutingDomain === "er" ? "Ephemeral Rollup" : display?.orderRoutingDomain === "l1" ? "Solana L1" : "refused"} />
        {display?.marketDelegated ? (
          <Row label="V3 bundle" level="ok" detail="27 accounts in the rollup" />
        ) : v3 ? <Row label="V3 bundle" level={v3.state === "available" ? (v3.completeExecutionState ? "ok" : "warn") : "down"} detail={v3.state === "available" ? `${v3.bookPageCount} pages · ${v3.seatShardCount} seats · ${v3.eventShardCount} events` : v3.state.replace("_", " ")} /> : null}
        <Row label="L1 commit" level={commit || display ? "ok" : "warn"} detail={commit ? `sequence ${commit}` : display ? `sequence ${display.lastCommittedL1Sequence}` : "unavailable"} />
      </div>
    </section>
  );
}

/** Slim footer strip: connection truth on the left, reference links on the right. */
export function ProtocolStatusStrip({ authenticated, v3, delegated = null, oracleOnline }: { authenticated: boolean; v3: V3MarketReadiness; delegated?: boolean | null; oracleOnline: boolean }) {
  return (
    <section aria-label="StockStream status" className="flex h-[32px] shrink-0 items-center gap-4 border-t border-[var(--t-border)] px-4 text-[11px] text-[var(--t-text-3)]">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${oracleOnline ? "bg-[var(--t-up)]" : "bg-[var(--t-text-2)]"}`} />
        <span className={oracleOnline ? "text-[var(--t-up)]" : "text-[var(--t-text-2)]"}>{oracleOnline ? "Pyth price verified" : "Waiting for a verified price"}</span>
      </span>
      <span className="hidden sm:inline">Devnet · worthless test tokens</span>
      <span className="hidden md:inline">Session: <span className="text-[var(--t-text-2)]">{authenticated ? "authenticated" : "not authenticated"}</span></span>
      <span className="hidden lg:inline">V3 delegation: <span className="text-[var(--t-text-2)]">{delegated ? "delegated to MagicBlock" : v3.delegationStatus === null ? "unknown" : ["not delegated", "delegated", "undelegating", "restored"][v3.delegationStatus] ?? String(v3.delegationStatus)}</span></span>
      <div className="ml-auto flex items-center gap-4">
        <a href="https://docs.magicblock.gg/" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[var(--t-text)]">MagicBlock</a>
        <a href="https://www.pyth.network/" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[var(--t-text)]">Pyth</a>
        <a href="/diagnostics" className="transition-colors hover:text-[var(--t-text)]">Diagnostics</a>
      </div>
    </section>
  );
}
