"use client";

import { Spinner } from "@/components/ui/spinner";
export type TicketKind = "market" | "limit";

export interface Ticket {
  kind: TicketKind;
  side: "long" | "short";
  price: string;
  amount: string;
  leverage: number;
  slippageBps: string;
  postOnly: boolean;
  reduceOnly: boolean;
  expiresInMinutes: string;
}

export const DEFAULT_TICKET: Ticket = { kind: "limit", side: "long", price: "", amount: "", leverage: 2, slippageBps: "50", postOnly: false, reduceOnly: false, expiresInMinutes: "" };

export interface SizedOrder { shares: number; entryPrice: number; notional: number; margin: number; limitPriceUsd: string }

/** Sizes a ticket: notional = amount × multiplier, shares = ⌊notional ÷ entry⌋.
 * Market orders cross as IOC at the mark widened by the slippage band. */
export function sizeTicket(ticket: Ticket, markPrice: number | null, initialMarginBps: number): SizedOrder | null {
  const entry = ticket.kind === "market" ? markPrice : Number(ticket.price);
  const amount = Number(ticket.amount);
  if (!entry || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(amount) || amount <= 0) return null;
  const shares = Math.floor((amount * ticket.leverage) / entry);
  const notional = shares * entry;
  const bps = Math.min(Math.max(Number.parseInt(ticket.slippageBps, 10) || 50, 1), 5_000);
  const band = ticket.side === "long" ? 1 + bps / 10_000 : 1 - bps / 10_000;
  const limitPriceUsd = ticket.kind === "market" ? (entry * band).toFixed(2) : ticket.price;
  return { shares, entryPrice: entry, notional, margin: (notional * initialMarginBps) / 10_000, limitPriceUsd };
}

const FOCUS = "focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--t-up)]";
const INPUT = `tnum h-[34px] w-full rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-[10px] pr-14 text-[13px] text-[var(--t-text)] placeholder:text-[var(--t-text-3)] ${FOCUS}`;
const SUFFIX = "pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 text-[11px] text-[var(--t-text-3)]";
const LABEL = "text-[12px] text-[var(--t-text-2)]";
const ROW = "flex h-[22px] items-center justify-between border-b border-[var(--t-surface-2)] last:border-b-0";
const CHIP = `tnum h-[26px] rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] text-[11.5px] text-[var(--t-text-2)] hover:text-[var(--t-text)] ${FOCUS}`;

/** Order entry (SlipStream OrderForm) for a Equinox perp. */
export function OrderTicket({
  ticket,
  onChange,
  ticker,
  markPrice,
  maxLeverage,
  initialMarginBps,
  availableUsd,
  ctaLabel,
  blocker,
  pending,
  footnote,
  onSubmit,
}: {
  ticket: Ticket;
  onChange: (next: Ticket) => void;
  ticker: string;
  markPrice: number | null;
  maxLeverage: number;
  initialMarginBps: number;
  /** Free collateral in the seat, or null when it has not been read. */
  availableUsd: number | null;
  ctaLabel: string;
  blocker: string | null;
  pending: boolean;
  footnote: string;
  onSubmit: () => void;
}) {
  const set = (patch: Partial<Ticket>) => onChange({ ...ticket, ...patch });
  const isMarket = ticket.kind === "market";
  const sized = sizeTicket(ticket, markPrice, initialMarginBps);
  const insufficient = sized !== null && availableUsd !== null && sized.margin > availableUsd + 1e-6;
  const disabled = pending || blocker !== null;
  const buyLabel = isMarket ? "Buy" : "Long";
  const sellLabel = isMarket ? "Sell" : "Short";

  return (
    <section aria-label="Place order" className="order-panel flex flex-col border-b border-[var(--t-border)] bg-[var(--t-bg)]">
      <div className="flex h-[40px] items-stretch gap-4 border-b border-[var(--t-border)] px-3" role="group" aria-label="Order type">
        {(["market", "limit"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => set({ kind })}
            aria-pressed={ticket.kind === kind}
            className={`relative text-[13px] font-medium ${FOCUS} ${ticket.kind === kind ? "text-[var(--t-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[var(--t-text)]" : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"}`}
          >
            {kind === "market" ? "Market" : "Limit"}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-[var(--t-text-3)]">Isolated · {ticker}</span>
      </div>

      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Order direction">
          {(["long", "short"] as const).map((side) => {
            const on = ticket.side === side;
            const long = side === "long";
            return (
              <button
                key={side}
                type="button"
                onClick={() => set({ side })}
                aria-pressed={on}
                className={`flex h-[44px] items-center justify-center rounded-[4px] border text-[13px] font-medium ${FOCUS} ${
                  on
                    ? long ? "border-[var(--t-up)] bg-[rgba(34,197,94,0.12)] text-[var(--t-up)]" : "border-[var(--t-down)] bg-[rgba(239,68,68,0.12)] text-[var(--t-down)]"
                    : "border-[var(--t-border-strong)] bg-[var(--t-surface)] text-[var(--t-text-2)] hover:text-[var(--t-text)]"
                }`}
              >
                <span className="flex flex-col items-center leading-tight">
                  <span>{long ? buyLabel : sellLabel}</span>
                  <span className="text-[10px] font-normal">{isMarket ? (long ? "takes the best ask now" : "hits the best bid now") : long ? "profits if price rises" : "profits if price falls"}</span>
                </span>
              </button>
            );
          })}
        </div>

        {isMarket ? (
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Execution</span>
            <p className="text-[11.5px] text-[var(--t-text-3)]">
              {markPrice === null ? "Waiting for the verified Pyth price…" : <>Crosses the book now as immediate-or-cancel, around <span className="tnum">{markPrice.toFixed(2)}</span>.</>}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="order-price" className={LABEL}>Limit price</label>
            <div className="relative">
              <input id="order-price" type="number" step="0.01" inputMode="decimal" placeholder={markPrice ? markPrice.toFixed(2) : "0.00"} value={ticket.price} onChange={(e) => set({ price: e.target.value })} className={INPUT} />
              <span className={SUFFIX}>USD</span>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="order-amount" className={LABEL}>Amount</label>
            <span className="tnum text-[11.5px] text-[var(--t-text-3)]">{availableUsd === null ? "collateral unknown" : `${availableUsd.toFixed(2)} available`}</span>
          </div>
          <div className="relative">
            <input id="order-amount" type="number" step="1" inputMode="decimal" placeholder="0.00" value={ticket.amount} onChange={(e) => set({ amount: e.target.value })} className={INPUT} />
            <span className={SUFFIX}>USDC</span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {[10, 50, 100, 250].map((m) => <button key={m} type="button" onClick={() => set({ amount: String(m) })} className={CHIP}>${m}</button>)}
            <button type="button" onClick={() => set({ amount: availableUsd && availableUsd > 0 ? String(Math.floor(availableUsd)) : "" })} className={CHIP}>Max</button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="order-lev" className={LABEL}>Size multiplier</label>
            <span className="tnum text-[12px] font-semibold text-[var(--t-up)]">{ticket.leverage}×</span>
          </div>
          <input id="order-lev" type="range" min={1} max={maxLeverage} step={1} value={ticket.leverage} onChange={(e) => set({ leverage: Number.parseInt(e.target.value, 10) })} className={`w-full cursor-pointer accent-[var(--t-up)] ${FOCUS}`} />
          <div className="tnum flex justify-between text-[11px] text-[var(--t-text-3)]">
            {Array.from({ length: maxLeverage }, (_, i) => <span key={i}>{i + 1}×</span>)}
          </div>
        </div>

        {isMarket ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="order-slippage" className={LABEL}>Max slippage</label>
              <span className="text-[11.5px] text-[var(--t-text-3)]">basis points</span>
            </div>
            <div className="relative">
              <input id="order-slippage" type="number" step="1" min={1} inputMode="numeric" placeholder="50" value={ticket.slippageBps} onChange={(e) => set({ slippageBps: e.target.value })} className={INPUT} />
              <span className={SUFFIX}>bps</span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--t-text-2)]">
          {!isMarket && (
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={ticket.postOnly} onChange={(e) => set({ postOnly: e.target.checked })} className="accent-[var(--t-up)]" /> Post-only</label>
          )}
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={ticket.reduceOnly} onChange={(e) => set({ reduceOnly: e.target.checked })} className="accent-[var(--t-up)]" /> Reduce-only</label>
          {!isMarket && (
            <label className="ml-auto flex items-center gap-1.5">Expires
              <input type="number" min={0} inputMode="numeric" placeholder="GTC" value={ticket.expiresInMinutes} onChange={(e) => set({ expiresInMinutes: e.target.value })} className={`tnum h-[26px] w-[64px] rounded-[4px] border border-[var(--t-border-strong)] bg-[var(--t-surface)] px-2 text-[12px] text-[var(--t-text)] ${FOCUS}`} aria-label="Expires in minutes (empty for GTC)" /> min
            </label>
          )}
        </div>

        <div className="flex flex-col">
          <div className={ROW}><span className={LABEL}>{isMarket ? "Action" : "Direction"}</span><span className="text-[12px] text-[var(--t-text)]">{ticket.side === "long" ? buyLabel : sellLabel}</span></div>
          <div className={ROW}><span className={LABEL}>Size</span><span className="tnum text-[12px] text-[var(--t-text)]">{sized && sized.shares > 0 ? `${sized.shares} ${ticker}` : "—"}</span></div>
          <div className={ROW}><span className={LABEL}>Notional</span><span className="tnum text-[12px] text-[var(--t-text)]">{sized && sized.shares > 0 ? `$${sized.notional.toFixed(2)}` : "—"}</span></div>
          <div className={ROW}><span className={LABEL}>Initial margin ({initialMarginBps / 100}%)</span><span className="tnum text-[12px] text-[var(--t-text)]">{sized && sized.shares > 0 ? `$${sized.margin.toFixed(2)}` : "—"}</span></div>
          <div className={ROW}><span className={LABEL}>Available collateral</span><span className="tnum text-[12px] text-[var(--t-text)]">{availableUsd === null ? "—" : `$${availableUsd.toFixed(2)}`}</span></div>
        </div>

        {sized && sized.shares === 0 && <p className="text-[11.5px] text-[var(--t-warn)]">Too small for one share — raise the amount or the multiplier.</p>}
        {insufficient && <p className="text-[11.5px] text-[var(--t-down)]">Needs ${sized!.margin.toFixed(2)} initial margin; you have ${availableUsd!.toFixed(2)}. Deposit more in the Account panel below.</p>}

        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className={`h-[38px] min-h-[38px] w-full rounded-[6px] text-[14px] font-semibold ${FOCUS} ${
            disabled ? "cursor-not-allowed bg-[var(--t-surface-3)] text-[var(--t-text-2)]" : ticket.side === "long" ? "bg-[var(--t-up-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-up-2)]" : "bg-[var(--t-down-3)] text-[var(--t-on-fill)] hover:bg-[var(--t-down-2)]"
          }`}
        >
          {pending ? <span className="inline-flex items-center justify-center gap-2"><Spinner className="h-4 w-4" /> Placing in the rollup…</span> : blocker ?? ctaLabel}
        </button>
        <p className="text-[11.5px] text-[var(--t-text-3)]">{footnote}</p>
      </div>
    </section>
  );
}
