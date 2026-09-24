"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { TraderSeatView } from "@/lib/positions";
import { PRICE_SCALE, type Trade } from "./use-v3-book";
import { MarketIcon } from "@/components/ui/market-icon";
import { marketPair } from "@/lib/v3-markets";

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

/** An inline "label value" pair for a card's figures row. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <span className="whitespace-nowrap"><span className="text-[var(--t-text-3)]">{label}</span> <span className="tnum text-[var(--t-text)]">{children}</span></span>;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Positions as glass cards (Hyperliquid's columns): size and value, entry
 * and mark, PnL with return on the initial margin, collateral and health,
 * and a one-click reduce-only market close (all, or half). */
function PositionsPanel({ seat, error, symbol, markPrice, signedIn, initialMarginBps, onClose, closing }: {
  seat: TraderSeatView | null; error: string | null; symbol: string; markPrice: number | null; signedIn: boolean;
  initialMarginBps: number; onClose?: (fraction: 1 | 0.5) => void; closing: boolean;
}) {
  if (!signedIn) return <Empty>Connect a wallet to see your position.</Empty>;
  if (error) return <Empty>{error}</Empty>;
  if (!seat) return <Empty>No margin account in this market yet. Press Start trading to open one and deposit.</Empty>;
  const view = positionView(seat, markPrice);
  const collateral = (Number(seat.availableCollateral) + Number(seat.reservedMargin)) / 1e6;
  if (!view) return <Empty>No open position · {usd(collateral)} collateral ready to trade.</Empty>;
  const long = view.side === "Long";
  const value = markPrice === null ? null : view.size * markPrice;
  const margin = (view.size * view.entry * initialMarginBps) / 10_000;
  const roe = view.pnl === null || margin <= 0 ? null : (view.pnl / margin) * 100;
  const leverage = value !== null && collateral > 0 ? value / collateral : null;
  const pnlTone = view.pnl === null ? "" : view.pnl >= 0 ? "text-[var(--t-up)]" : "text-[var(--t-down)]";
  const health = seat.liquidationState === "healthy" ? "text-[var(--t-up)]" : seat.liquidationState === "warning" ? "text-[var(--t-warn)]" : "text-[var(--t-down)]";
  return (
    <div className="p-2">
      <article className="glass-card card-enter relative overflow-hidden py-2 pl-3.5 pr-2.5">
        <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${long ? "bg-[var(--t-up)]" : "bg-[var(--t-down)]"}`} />
        <div className="flex items-center gap-2">
          <MarketIcon symbol={symbol} size={24} />
          <span className="truncate text-[13px] font-semibold text-[var(--t-text)]">{marketPair(symbol)}</span>
          <span className={`rounded px-1.5 py-px text-[10.5px] font-semibold ${long ? "bg-[var(--t-up-soft)] text-[var(--t-up)]" : "bg-[var(--t-down-soft)] text-[var(--t-down)]"}`}>{view.side} {view.size}</span>
          {leverage !== null ? <span className="tnum hidden text-[11px] text-[var(--t-text-3)] sm:inline" title="Position value ÷ collateral">{leverage.toFixed(1)}×</span> : null}
          <span className={`tnum ml-auto whitespace-nowrap text-[13px] font-semibold ${pnlTone}`} title="Unrealized PnL at the mark (return on initial margin)">
            {view.pnl === null ? "—" : `${view.pnl >= 0 ? "+" : "−"}${usd(Math.abs(view.pnl))}`}
            {roe === null ? null : <span className="ml-1 text-[11px] font-medium">({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)</span>}
          </span>
          {onClose ? (
            <span className="flex shrink-0 items-center gap-1">
              <button type="button" disabled={closing || view.size < 2} onClick={() => onClose(0.5)} title={view.size < 2 ? "A 1-share position closes whole" : "Market-close half, reduce-only"} className="h-6 rounded-full border border-[var(--t-border)] px-2.5 text-[11px] text-[var(--t-text-2)] hover:text-[var(--t-text)] disabled:opacity-40">50%</button>
              <button type="button" disabled={closing} onClick={() => onClose(1)} title="Market-close the whole position, reduce-only" className={`h-6 rounded-full px-3 text-[11px] font-semibold text-[var(--t-on-fill)] disabled:opacity-50 ${long ? "bg-[var(--t-down-3)] hover:bg-[var(--t-down-2)]" : "bg-[var(--t-up-3)] hover:bg-[var(--t-up-2)]"}`}>{closing ? "Closing…" : "Close"}</button>
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 pl-8 text-[11.5px]">
          <Stat label="Value">{value === null ? "—" : usd(value)}</Stat>
          <Stat label="Entry">{view.entry.toFixed(2)}</Stat>
          <Stat label="Mark">{markPrice === null ? "—" : markPrice.toFixed(2)}</Stat>
          <Stat label="Collateral">{usd(collateral)}</Stat>
          <Stat label="Health"><span className={health}>{seat.liquidationState}</span></Stat>
        </div>
      </article>
    </div>
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
export function ActivityDrawer({ seat, seatError, seatIndex, symbol, markPrice, trades, openOrders, aside, loading = false, signedIn = true, initialMarginBps, onClosePosition, closing = false }: {
  seat: TraderSeatView | null; seatError: string | null; seatIndex: number | null; symbol: string; markPrice: number | null; trades: Trade[]; openOrders: ReactNode;
  initialMarginBps: number;
  /** Reduce-only market close of the whole position, or half. */
  onClosePosition?: (fraction: 1 | 0.5) => void;
  closing?: boolean;
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
      <div id="activity-panel" role="tabpanel" className={`slim-scroll h-[132px] overflow-auto ${open ? "" : "hidden"}`}>
        {tab === "positions" && (loading ? <Loading what="your position" /> : <PositionsPanel seat={seat} error={seatError} symbol={symbol} markPrice={markPrice} signedIn={signedIn} initialMarginBps={initialMarginBps} onClose={onClosePosition} closing={closing} />)}
        <div className={tab === "orders" ? "" : "hidden"}>{openOrders}</div>
        {tab === "history" && (loading ? <Loading what="your fills" /> : <TradeHistory trades={trades} seatIndex={seatIndex} />)}
      </div>
    </section>
    {aside}
    </div>
  );
}
