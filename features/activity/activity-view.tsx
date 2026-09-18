"use client";

import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useLastSignature } from "@/lib/use-last-signature";
import { useMarketEvents } from "./use-market-events";

const marketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL;

export function ActivityView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP";
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const lastSignature = useLastSignature();
  const { events, status, gapCount, duplicateCount, lastGapAt } = useMarketEvents(marketApiUrl, marketSymbol);

  return (
    <main className="shell">
      <TopBar active="activity" auth={auth} />
      <div className="activity-grid">
        <section className="session-panel">
          <div className="panel-title"><h2>This session</h2><span>local, not persisted</span></div>
          {lastSignature ? (
            <dl className="session-detail">
              <dt>Last action</dt><dd>{lastSignature.instruction}</dd>
              <dt>Signature</dt><dd>{lastSignature.signature}</dd>
              <dt>Domain</dt><dd>{lastSignature.domain}</dd>
              <dt>At</dt><dd>{new Date(lastSignature.at).toLocaleString()}</dd>
            </dl>
          ) : (
            <p className="form-note">No submitted transactions yet this session.</p>
          )}
        </section>

        <section className="session-panel">
          <div className="panel-title"><h2>ER / L1 commit status</h2><span>{executionStatus ? "live" : "unavailable"}</span></div>
          {executionStatus ? (
            <dl className="session-detail">
              <dt>Status</dt><dd>{executionStatus.marketDelegated ? "delegated (ER)" : "not delegated"}</dd>
              <dt>Commit pending</dt><dd>{executionStatus.commitPending ? "yes" : "no"}</dd>
              <dt>Last ER sequence</dt><dd>{executionStatus.lastErSequence}</dd>
              <dt>Last committed L1 sequence</dt><dd>{executionStatus.lastCommittedL1Sequence}</dd>
            </dl>
          ) : (
            <p className="form-note">Execution status unavailable.</p>
          )}
        </section>

        <section className="session-panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-title"><h2>Recent market events</h2><span>{status}</span></div>
          {gapCount > 0 ? (
            <p className="form-note negative">
              {gapCount} sequence gap{gapCount === 1 ? "" : "s"} detected on this connection
              {lastGapAt ? ` (most recent ${new Date(lastGapAt).toLocaleTimeString()})` : ""} -- missed events
              were never fabricated; a fresh snapshot was fetched to resynchronize instead.
              {duplicateCount > 0 ? ` ${duplicateCount} duplicate/out-of-order event(s) were also dropped.` : ""}
            </p>
          ) : duplicateCount > 0 ? (
            <p className="form-note">{duplicateCount} duplicate/out-of-order event(s) dropped.</p>
          ) : null}
          {events.length === 0 ? (
            <p className="form-note">No events observed yet.</p>
          ) : (
            <table className="activity-table">
              <thead><tr><th>Kind</th><th>Sequence</th><th>Domain</th><th>Observed</th></tr></thead>
              <tbody>
                {events.slice(0, 30).map((event) => (
                  <tr key={event.id}>
                    <td>{event.kind}</td>
                    <td>{event.sequence ?? "--"}</td>
                    <td>{event.domain ?? "--"}</td>
                    <td>{new Date(event.observedAt).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="form-note">
            Kinds are limited to book/fill/funding/health/oracle/custody -- there is no finer-grained
            order-placed/cancelled/replaced/liquidated breakdown available without the canonical event ABI
            manifest (blocked on the main-agent workstream). Deposits and withdrawals from this session are
            shown above instead, since those are tracked locally.
          </p>
        </section>
      </div>
    </main>
  );
}
