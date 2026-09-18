import { decimal, formatUsd } from "./format";

export interface BookLevel { price: string; size: string; }

function BookRows({ values, side }: { values: BookLevel[]; side: "ask" | "bid" }) {
  const largest = Math.max(...values.map((level) => decimal(level.size, 1_000_000_000)), 1);
  return (
    <div className="book-rows">
      {values.map((level) => {
        const price = decimal(level.price, 1_000_000);
        const size = decimal(level.size, 1_000_000_000);
        return (
          <div key={`${level.price}-${level.size}`} className={side}>
            <span>{Number.isFinite(price) ? price.toFixed(2) : "--"}</span>
            <span>{Number.isFinite(size) ? size.toFixed(3) : "--"}</span>
            <span>{Number.isFinite(size) ? (size * price).toFixed(2) : "--"}</span>
            <i style={{ width: `${Math.max(8, (size / largest) * 75)}%` }} />
          </div>
        );
      })}
    </div>
  );
}

export function OrderBookPanel({
  book,
  markPrice,
  bestBid,
  bestAsk,
}: {
  book: { bids: BookLevel[]; asks: BookLevel[] };
  markPrice: number;
  bestBid: number;
  bestAsk: number;
}) {
  return (
    <section className="book-panel">
      <div className="panel-title">
        <h2>Order book</h2>
        <span>Price-time priority</span>
      </div>
      <BookRows values={book.asks} side="ask" />
      <div className="book-spread">
        <strong>{Number.isFinite(markPrice) ? formatUsd(markPrice) : "--"}</strong>
        <span>{Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? `spread ${formatUsd(bestAsk - bestBid)}` : "awaiting ER data"}</span>
      </div>
      <BookRows values={book.bids} side="bid" />
      <div className="book-foot">
        <span>Fixed + oracle-pegged roots</span>
        <span>ER live</span>
      </div>
    </section>
  );
}
