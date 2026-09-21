"use client";

import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useLastSignature } from "@/lib/use-last-signature";
import { marketForSymbol } from "@/lib/markets";
import { STOCKSTREAM_PROGRAM_ID } from "@/clients/stockstream/src/constants";
import { DEMO_DEPLOYED_ARTIFACT_SHA256, DEMO_LOCAL_ARTIFACT_SHA256, DEMO_PROGRAM_ID, publicMarketApiUrl, publicV3Core } from "@/lib/demo-config";
import { useEffect, useState } from "react";

const marketApiUrl = publicMarketApiUrl;
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
  const [workerHealth, setWorkerHealth] = useState<"checking" | "healthy" | "unavailable">("checking");

  useEffect(() => {
    if (!protocol) return;
    let stopped = false;
    protocol.rpc.market(marketAddress).then((market) => { if (!stopped) setMarketVersion(market.state.version); }).catch(() => {});
    protocol.rpc.currentSlot().then((slot) => { if (!stopped) setL1Slot(slot); }).catch(() => {});
    return () => { stopped = true; };
  }, [protocol, marketAddress]);

  useEffect(() => {
    let stopped = false;
    fetch(`${marketApiUrl}/health`).then((response) => {
      if (!stopped) setWorkerHealth(response.ok ? "healthy" : "unavailable");
    }).catch(() => { if (!stopped) setWorkerHealth("unavailable"); });
    return () => { stopped = true; };
  }, []);

  return (
    <main className="shell">
      <TopBar active="diagnostics" auth={auth} />
      <section className="session-panel" style={{ marginTop: 20 }}>
        <div className="panel-title"><h2>Demo diagnostics</h2><span>read-only Devnet</span></div>
        <p className="form-note">This panel reports public deployment facts only. Trading, relay, restoration, and withdrawal are intentionally unavailable in the demo.</p>
        <dl className="session-detail">
          <dt>Program ID</dt><dd>{DEMO_PROGRAM_ID || STOCKSTREAM_PROGRAM_ID}</dd>
          <dt>Configured V3 core</dt><dd>{publicV3Core}</dd>
          <dt>Artifact alignment</dt><dd className="negative">mismatch · local {DEMO_LOCAL_ARTIFACT_SHA256.slice(0, 12)}… / deployed {DEMO_DEPLOYED_ARTIFACT_SHA256.slice(0, 12)}…</dd>
          <dt>Pyth AAPL/USD</dt><dd className="negative">blocked · feed 922 not entitled</dd>
          <dt>Privy session relay</dt><dd className="negative">unavailable · credentials not configured</dd>
          <dt>Worker health</dt><dd>{workerHealth === "healthy" ? "healthy · public read-only" : workerHealth}</dd>
          <dt>MagicBlock lifecycle</dt><dd className="negative">restoration blocked · deployed DLP wire mismatch</dd>
          <dt>Demo mode</dt><dd>deterministic local fixtures; no live trading</dd>
          <dt>Production write gate</dt><dd>read-only by default; no demo writes to the preserved core</dd>
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
        <p className="form-note">Never displays private keys or server secrets. Withdrawal remains unavailable while the preserved core awaits compatible MagicBlock restoration.</p>
      </section>
    </main>
  );
}
