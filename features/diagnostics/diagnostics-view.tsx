"use client";

import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useLastSignature } from "@/lib/use-last-signature";
import { marketForSymbol } from "@/lib/markets";
import { STOCKSTREAM_PROGRAM_ID } from "@/clients/stockstream/src/constants";
import { DEMO_DEPLOYED_ARTIFACT_SHA256, DEMO_LOCAL_ARTIFACT_SHA256, DEMO_ORACLE_SNAPSHOT, DEMO_PROGRAM_ID, publicMarketApiUrl, publicV3Core } from "@/lib/demo-config";
import { useEffect, useMemo, useState } from "react";
import { decodeV3MarketCore, type V3MarketCoreView } from "@/clients/stockstream/src/abi/v3";
import { SolanaRpcTransport } from "@/lib/rpc-transport";
import { useMarketClock } from "@/features/oracle/use-market-clock";
import deployment from "@/config/stockstream-deployment.json";

const DELEGATION_STATUS = ["not delegated", "delegated", "undelegating", "restored"];
const writesEnabled = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_STOCKSTREAM_DEMO_READ_ONLY === "false";

const marketApiUrl = publicMarketApiUrl;
const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_STOCKSTREAM_RELAYER_ADDRESS;

export function DiagnosticsView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? (publicV3Core ? marketConfig.marketPda : null);
  const protocol = useStockStreamProtocol(auth.authenticated ? marketAddress : null);
  const session = useTradingSession(protocol, auth.walletAddress, marketAddress, 0);
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const lastSignature = useLastSignature();
  const [core, setCore] = useState<V3MarketCoreView | null>(null);
  const [l1Slot, setL1Slot] = useState<number | null>(null);
  const [erSlot, setErSlot] = useState<number | null>(null);
  // Public chain state: readable before sign-in.
  const l1 = useMemo(() => new SolanaRpcTransport(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com"), []);
  const er = useMemo(() => new SolanaRpcTransport(deployment.magicBlock.rpc), []);
  const clock = useMarketClock(DEMO_ORACLE_SNAPSHOT ? l1 : null, publicV3Core || null, DEMO_ORACLE_SNAPSHOT);
  const [now, setNow] = useState(0);
  const [workerHealth, setWorkerHealth] = useState<"checking" | "healthy" | "unavailable">("checking");

  useEffect(() => {
    let stopped = false;
    if (publicV3Core) l1.accountBytes(publicV3Core).then((bytes) => { if (!stopped) setCore(decodeV3MarketCore(bytes)); }).catch(() => {});
    l1.currentSlot().then((slot) => { if (!stopped) { setL1Slot(slot); setNow(Math.floor(Date.now() / 1000)); } }).catch(() => {});
    er.currentSlot().then((slot) => { if (!stopped) setErSlot(slot); }).catch(() => {});
    return () => { stopped = true; };
  }, [l1, er, clock]);

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
        <div className="panel-title"><h2>Diagnostics</h2><span>Devnet</span></div>
        <p className="form-note">Public deployment facts, read live from Devnet, MagicBlock and the market API.</p>
        <dl className="session-detail">
          <dt>Program ID</dt><dd>{DEMO_PROGRAM_ID || STOCKSTREAM_PROGRAM_ID}</dd>
          <dt>Configured V3 core</dt><dd>{publicV3Core}</dd>
          <dt>Artifact alignment</dt><dd className={DEMO_LOCAL_ARTIFACT_SHA256 === DEMO_DEPLOYED_ARTIFACT_SHA256 ? undefined : "negative"}>{DEMO_LOCAL_ARTIFACT_SHA256 === DEMO_DEPLOYED_ARTIFACT_SHA256 ? "matched" : "mismatch"} · local {DEMO_LOCAL_ARTIFACT_SHA256.slice(0, 12)}… · deployed {DEMO_DEPLOYED_ARTIFACT_SHA256.slice(0, 12)}…</dd>
          <dt>Pyth TSLA/USD snapshot</dt><dd className={clock?.oracle ? undefined : "negative"}>{clock?.oracle
            ? `authenticated · $${clock.oracle.price.toFixed(2)} ± $${clock.oracle.confidence.toFixed(2)} · sequence ${clock.oracle.sequence} · ${now ? `${Math.max(0, now - Number(clock.lastVerifiedOracleTimestamp))}s old` : "age unknown"} · feed 1435`
            : "unavailable"}</dd>
          <dt>Core state</dt><dd>{core ? `mode ${core.mode === 1 ? "active" : core.mode} · ${DELEGATION_STATUS[core.delegationStatus] ?? core.delegationStatus} · last commit ${core.lastCommittedSequence}` : "unavailable"}</dd>
          <dt>Worker health</dt><dd>{workerHealth}</dd>
          <dt>Write gate</dt><dd>{writesEnabled ? "L1 custody writes enabled (seat, deposit, withdraw)" : "read-only build"}</dd>
          <dt>Market address</dt><dd>{marketAddress ?? "unconfigured"}</dd>
          <dt>Session PDA</dt><dd>{session.status?.sessionPda ?? "no active session"}</dd>
          <dt>Session public key</dt><dd>{session.status?.sessionSignerAddress ?? "none"}</dd>
          <dt>L1 slot</dt><dd>{l1Slot ?? "unavailable"}</dd>
          <dt>ER slot</dt><dd>{erSlot ?? "unavailable"}</dd>
          <dt>Last ER sequence</dt><dd>{executionStatus?.lastErSequence ?? "unavailable"}</dd>
          <dt>Last committed L1 sequence</dt><dd>{executionStatus?.lastCommittedL1Sequence ?? "unavailable"}</dd>
          <dt>Delegation state</dt><dd>{executionStatus ? `${executionStatus.marketDelegated ? "delegated" : "not delegated"}${executionStatus.degraded ? " (reconciliation error)" : ""}` : "unavailable"}</dd>
          <dt>Relayer fee payer</dt><dd>{RELAYER_ADDRESS ?? "unconfigured (relayer_signer_unconfigured)"}</dd>
          <dt>Last transaction signature</dt><dd>{lastSignature ? `${lastSignature.instruction} · ${lastSignature.signature} (${lastSignature.domain}, ${new Date(lastSignature.at).toLocaleTimeString()})` : "none this session"}</dd>
        </dl>
        <p className="form-note">Never displays private keys or server secrets.</p>
      </section>
    </main>
  );
}
