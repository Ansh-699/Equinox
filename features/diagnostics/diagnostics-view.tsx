"use client";

import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useLastSignature } from "@/lib/use-last-signature";
import { marketForSymbol } from "@/lib/markets";
import { STOCKSTREAM_PROGRAM_ID } from "@/clients/stockstream/src/constants";
import { useEffect, useState } from "react";

const marketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL;
const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS;

export function DiagnosticsView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useStockStreamProtocol(auth.authenticated ? marketAddress : null);
  const session = useTradingSession(protocol, auth.walletAddress, marketAddress, 0);
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const lastSignature = useLastSignature();
  const [marketVersion, setMarketVersion] = useState<number | null>(null);
  const [l1Slot, setL1Slot] = useState<number | null>(null);

  useEffect(() => {
    if (!protocol) return;
    let stopped = false;
    protocol.rpc.market(marketAddress).then((market) => { if (!stopped) setMarketVersion(market.state.version); }).catch(() => {});
    protocol.rpc.currentSlot().then((slot) => { if (!stopped) setL1Slot(slot); }).catch(() => {});
    return () => { stopped = true; };
  }, [protocol, marketAddress]);

  if (process.env.NODE_ENV === "production") {
    return (
      <main className="shell">
        <TopBar active="diagnostics" auth={auth} />
        <p className="form-note">Diagnostics is development-only.</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <TopBar active="diagnostics" auth={auth} />
      <section className="session-panel" style={{ marginTop: 20 }}>
        <div className="panel-title"><h2>Diagnostics</h2><span>development-only</span></div>
        <dl className="session-detail">
          <dt>Program ID</dt><dd>{STOCKSTREAM_PROGRAM_ID}</dd>
          <dt>Market account version</dt><dd>{marketVersion ?? "unavailable"}</dd>
          <dt>Market address</dt><dd>{marketAddress ?? "unconfigured"}</dd>
          <dt>Seat index</dt><dd>0 (seats are embedded in the market account, not separate PDAs)</dd>
          <dt>Session PDA</dt><dd>{session.status?.sessionPda ?? "no active session"}</dd>
          <dt>Session public key</dt><dd>{session.status?.sessionSignerAddress ?? "none"}</dd>
          <dt>L1 slot</dt><dd>{l1Slot ?? "unavailable"}</dd>
          <dt>ER slot</dt><dd>unavailable (no public ER RPC endpoint configured for the browser)</dd>
          <dt>Last ER sequence</dt><dd>{executionStatus?.lastErSequence ?? "unavailable"}</dd>
          <dt>Last committed L1 sequence</dt><dd>{executionStatus?.lastCommittedL1Sequence ?? "unavailable"}</dd>
          <dt>Delegation state</dt><dd>{executionStatus ? `${executionStatus.marketDelegated ? "delegated" : "not delegated"}${executionStatus.degraded ? " (reconciliation error)" : ""}` : "unavailable"}</dd>
          <dt>Relayer fee payer</dt><dd>{RELAYER_ADDRESS ?? "unconfigured (relayer_signer_unconfigured)"}</dd>
          <dt>Last transaction signature</dt><dd>{lastSignature ? `${lastSignature.instruction} · ${lastSignature.signature} (${lastSignature.domain}, ${new Date(lastSignature.at).toLocaleTimeString()})` : "none this session"}</dd>
        </dl>
        <p className="form-note">Never displays private keys or server secrets. Oracle age/staleness is omitted here pending the canonical oracle event ABI (see Trade page status banner).</p>
      </section>
    </main>
  );
}
