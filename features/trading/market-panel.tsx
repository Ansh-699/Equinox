import { Activity } from "lucide-react";
import { Metric } from "./primitives";
import { formatUsd } from "./format";

export function MarketPanel({
  marketSymbol,
  marketFeedStatus,
  markPrice,
  bestBid,
  bestAsk,
}: {
  marketSymbol: string;
  marketFeedStatus: "connecting" | "live" | "unavailable";
  markPrice: number;
  bestBid: number;
  bestAsk: number;
}) {
  return (
    <section className="market-panel">
      <div className="market-heading">
        <div>
          <p className="muted">US equities / perpetual</p>
          <h1>{marketSymbol} <span>{marketFeedStatus}</span></h1>
        </div>
        <div className="price">
          <strong>{Number.isFinite(markPrice) ? formatUsd(markPrice) : "--"}</strong>
          <span className={marketFeedStatus === "live" ? "positive" : "muted"}>{marketFeedStatus === "live" ? "ER verified" : "feed unavailable"}</span>
        </div>
      </div>
      <div className="market-stats">
        <Metric label="Best bid" value={Number.isFinite(bestBid) ? formatUsd(bestBid) : "--"} />
        <Metric label="Best ask" value={Number.isFinite(bestAsk) ? formatUsd(bestAsk) : "--"} />
        <Metric label="Feed" value={marketFeedStatus} />
        <Metric label="Source" value="MagicBlock ER" />
      </div>
      <div className="chart-area">
        <div className="chart-label">
          <span>Price / USD</span>
          <span className="muted">No verified oracle feed</span>
        </div>
        <div className="chart-empty">Market visualization is disabled until a verified data source is connected.</div>
      </div>
      <div className="execution-note">
        <Activity size={16} />
        <span>Perps risk reads only the Pyth index. Launch-pool values are analytics, never collateral or liquidation inputs.</span>
      </div>
    </section>
  );
}
