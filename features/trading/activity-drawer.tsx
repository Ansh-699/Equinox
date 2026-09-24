"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { TraderSeatView } from "@/lib/positions";
import { PRICE_SCALE, type Trade } from "./use-v3-book";

type Tab = "positions" | "orders" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Open Orders" },
  { id: "history", label: "Trade History" },
];

const TH = "px-3 py-1.5 text-left text-[11px] font-normal text-[var(--t-text-3)]";
const TD = "tnum px-3 py-1.5 text-[12px] text-[var(--t-text)]";

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-[12px] text-[var(--t-text-2)]">{children}</div>;
}
const Loading = ({ what }: { what: string }) => <Empty><Spinner /> Loading {what} from the rollup…</Empty>;

/** Entry = Σ(qty × raw price) ÷ position (programs/equinox/src/risk.rs), in USD. */
export function positionView(seat: TraderSeatView, markPrice: number | null) {
  const base = Number(seat.basePosition);
  if (base === 0) return null;
  const entry = Number(seat.quoteEntryValue) / base / PRICE_SCALE;
  const pnl = markPrice === null ? null : base * (markPrice - entry);
  return { side: base > 0 ? "Long" : "Short", size: Math.abs(base), entry, pnl };
}

function PositionsTable({ seat, error, symbol, markPrice, signedIn }: { seat: TraderSeatView | null; error: string | null; symbol: string; markPrice: number | null; signedIn: boolean }) {
  if (!signedIn) return <Empty>Connect a wallet to see your position.</Empty>;
  if (error) return <Empty>{error}</Empty>;
  if (!seat) return <Empty>No margin account in this market yet. Press Start trading to open one and deposit.</Empty>;
  const view = positionView(seat, markPrice);
  if (!view) return <Empty>No open position. Available collateral: ${(Number(seat.availableCollateral) / 1e6).toFixed(2)}.</Empty>;
  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 bg-[var(--t-bg)]"><tr>
        <th className={TH}>Market</th><th className={TH}>Side</th><th className={`${TH} text-right`}>Size</th><th className={`${TH} text-right`}>Entry</th>
        <th className={`${TH} text-right`}>Mark</th><th className={`${TH} text-right`}>uPnL</th><th className={`${TH} text-right`}>Reserved</th><th className={`${TH} text-right`}>Health</th>
      </tr></thead>
      <tbody>
        <tr className="border-t border-[var(--t-surface-2)]">
          <td className={`${TD} font-medium`}>{symbol}</td>
          <td className={`${TD} ${view.side === "Long" ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{view.side}</td>
          <td className={`${TD} text-right`}>{view.size}</td>
          <td className={`${TD} text-right`}>{view.entry.toFixed(2)}</td>
          <td className={`${TD} text-right`}>{markPrice === null ? "—" : markPrice.toFixed(2)}</td>
          <td className={`${TD} text-right ${view.pnl === null ? "" : view.pnl >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>{view.pnl === null ? "—" : `${view.pnl >= 0 ? "+" : "−"}$${Math.abs(view.pnl).toFixed(2)}`}</td>
          <td className={`${TD} text-right`}>${(Number(seat.reservedMargin) / 1e6).toFixed(2)}</td>
          <td className={`${TD} text-right ${seat.liquidationState === "healthy" ? "text-[var(--t-up)]" : seat.liquidationState === "warning" ? "text-[var(--t-warn)]" : "text-[var(--t-down)]"}`}>{seat.liquidationState}</td>
        </tr>
      </tbody>
    </table>
  );
}

function TradeHistory({ trades, seatIndex }: { trades: Trade[]; seatIndex: number | null }) {
  const mine = seatIndex === null ? [] : trades.filter((t) => t.makerSeat === seatIndex || t.takerSeat === seatIndex);
  if (seatIndex === null) return <Empty>Sign in to see your fills.</Empty>;
  if (mine.length === 0) return <Empty>No fills yet.</Empty>;
  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 bg-[var(--t-bg)]"><tr>
        <th className={TH}>Time</th><th className={TH}>Role</th><th className={`${TH} text-right`}>Price</th><th className={`${TH} text-right`}>Size</th><th className={`${TH} text-right`}>Notional</th><th className={`${TH} text-right`}>Sequence</th>
      </tr></thead>
      <tbody>
        {mine.map((t) => (
          <tr key={t.sequence} className="border-t border-[var(--t-surface-2)]">
            <td className={TD}>{t.time ? new Date(t.time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
            <td className={TD}>{t.makerSeat === seatIndex ? "Maker" : "Taker"}</td>
            <td className={`${TD} text-right`}>{t.price.toFixed(2)}</td>
            <td className={`${TD} text-right`}>{t.size}</td>
            <td className={`${TD} text-right`}>${(t.price * t.size).toFixed(2)}</td>
            <td className={`${TD} text-right text-[var(--t-text-2)]`}>#{t.sequence}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The activity drawer under the chart (SlipStream ActivityDrawer). Collapsed
 * it is only its tab strip, so the chart can take the whole column. */
export function ActivityDrawer({ seat, seatError, seatIndex, symbol, markPrice, trades, openOrders, aside, loading = false, signedIn = true }: {
  seat: TraderSeatView | null; seatError: string | null; seatIndex: number | null; symbol: string; markPrice: number | null; trades: Trade[]; openOrders: ReactNode;
  /** Right-hand third (the live rollup transaction feed). */
  aside?: ReactNode;
  /** The trader's seat has not been read yet. */
  loading?: boolean;
  signedIn?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("positions");
  const [open, setOpen] = useState(true);
  return (
    <div className="grid shrink-0 grid-cols-1 md:grid-cols-[2fr_1fr]">
    <section className="flex min-w-0 flex-col border-t border-[var(--t-border)]" aria-label="Your activity">
      <div className="tk-head gap-4">
        <div role="tablist" aria-label="Activity" className="no-scrollbar flex min-w-0 items-center gap-4 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} aria-controls="activity-panel" className="tk-tab" onClick={() => { setTab(t.id); setOpen(true); }}>
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? "Collapse activity" : "Expand activity"} className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "" : "rotate-180"}`} strokeWidth={1.75} />
        </button>
      </div>
      {/* Open orders stays mounted (hidden) so its state and actions survive tab switches. */}
      <div id="activity-panel" role="tabpanel" className={`slim-scroll h-[120px] overflow-auto ${open ? "" : "hidden"}`}>
        {tab === "positions" && (loading ? <Loading what="your position" /> : <PositionsTable seat={seat} error={seatError} symbol={symbol} markPrice={markPrice} signedIn={signedIn} />)}
        <div className={tab === "orders" ? "" : "hidden"}>{openOrders}</div>
        {tab === "history" && (loading ? <Loading what="your fills" /> : <TradeHistory trades={trades} seatIndex={seatIndex} />)}
      </div>
    </section>
    {aside}
    </div>
  );
}
