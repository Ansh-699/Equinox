import type { TraderSeatView } from "@/lib/positions";

const STATUS_CLASS: Record<TraderSeatView["liquidationState"], string> = {
  healthy: "positive",
  warning: "muted",
  liquidatable: "negative",
  bankrupt: "negative",
  unknown: "muted",
};

export function PositionsPanel({ seat, error }: { seat: TraderSeatView | null; error: string | null }) {
  return (
    <section className="session-panel">
      <div className="panel-title">
        <h2>Position</h2>
        {seat ? <span className={STATUS_CLASS[seat.liquidationState]}>{seat.liquidationState}</span> : <span>no seat</span>}
      </div>
      {error ? (
        <p className="form-note">{error}</p>
      ) : !seat ? (
        <p className="form-note">No trader seat found for this market/seat index. Construct a seat to open a position.</p>
      ) : (
        <>
          <dl className="session-detail">
            <dt>Base position</dt><dd>{seat.basePosition.toString()}</dd>
            <dt>Quote entry value</dt><dd>{seat.quoteEntryValue.toString()}</dd>
            <dt>Available collateral</dt><dd>{seat.availableCollateral.toString()}</dd>
            <dt>Reserved margin</dt><dd>{seat.reservedMargin.toString()}</dd>
            <dt>Realized PnL</dt><dd>{seat.realizedPnl.toString()}</dd>
            <dt>Open bid / ask exposure</dt><dd>{seat.openBidExposure.toString()} / {seat.openAskExposure.toString()}</dd>
            <dt>Open orders</dt><dd>{seat.openOrderCount}</dd>
          </dl>
          <p className="form-note">Raw on-chain fields (base units). Equity and unrealized PnL need the verified oracle mark price and the program&rsquo;s own risk formula; they are not computed client-side. The program remains authoritative for margin and health.</p>
        </>
      )}
    </section>
  );
}
