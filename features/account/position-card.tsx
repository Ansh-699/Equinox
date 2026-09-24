"use client";

import Link from "next/link";
import { LineChart } from "lucide-react";
import type { AccountSeat } from "@/features/portfolio/use-account-summary";
import { Badge, BUTTON_PRIMARY, EmptyState, formatUsdUnits, Skeleton } from "@/components/ui/primitives";

/** The seat's TSLA-PERP position: side, size and margin, or a clear way in. */
export function PositionCard({ seat, unavailable = false, market = "TSLA-PERP", compact = false }: { seat: AccountSeat | null | undefined; unavailable?: boolean; market?: string; compact?: boolean }) {
  const base = market.replace(/-PERP$/, "");
  if (seat === undefined && unavailable) {
    return <p className="py-4 text-center text-[12.5px] text-[var(--t-text-2)]">Couldn&apos;t read your position right now. Retrying every few seconds.</p>;
  }
  if (seat === undefined) {
    return <div className="space-y-2 p-1"><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-48" /></div>;
  }
  if (seat === null || (seat.position === 0n && seat.reserved === 0n && seat.available === 0n)) {
    return (
      <EmptyState icon={<LineChart className="h-5 w-5" />} title="No open position" action={<Link href={`/trade?market=${market}`} className={BUTTON_PRIMARY}>Start trading</Link>}>
        Go long or short {base} with USDC collateral. Orders match on the MagicBlock rollup and settle on Solana.
      </EmptyState>
    );
  }
  const side = seat.position > 0n ? "LONG" : seat.position < 0n ? "SHORT" : "FLAT";
  const size = seat.position < 0n ? -seat.position : seat.position;
  const pnlTone = seat.realizedPnl > 0n ? "text-[var(--t-up)]" : seat.realizedPnl < 0n ? "text-[var(--t-down)]" : "text-[var(--t-text)]";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--t-surface-3)] text-[12px] font-bold text-[var(--t-text)]">{base.slice(0, 1)}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[var(--t-text)]">{market}</span>
            <Badge tone={side === "LONG" ? "up" : side === "SHORT" ? "down" : "muted"}>{side}</Badge>
          </div>
          <div className="tnum text-[12px] text-[var(--t-text-2)]">{size.toString()} {base} · account #{seat.index}</div>
        </div>
        {!compact ? <Link href={`/trade?market=${market}`} className="ml-auto text-[12.5px] font-semibold text-[var(--t-link)] hover:underline">Trade {market} →</Link> : null}
      </div>
      <dl className="tnum grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
        <div><dt className="text-[11px] text-[var(--t-text-3)]">Available</dt><dd className="font-medium text-[var(--t-text)]">{formatUsdUnits(seat.available)}</dd></div>
        <div><dt className="text-[11px] text-[var(--t-text-3)]">Margin in use</dt><dd className="font-medium text-[var(--t-text)]">{formatUsdUnits(seat.reserved)}</dd></div>
        <div><dt className="text-[11px] text-[var(--t-text-3)]">Realized PnL</dt><dd className={`font-medium ${pnlTone}`}>{formatUsdUnits(seat.realizedPnl)}</dd></div>
        <div><dt className="text-[11px] text-[var(--t-text-3)]">Open orders</dt><dd className="font-medium text-[var(--t-text)]">{seat.openOrderCount}</dd></div>
      </dl>
      {compact ? <Link href={`/trade?market=${market}`} className="inline-block text-[12.5px] font-semibold text-[var(--t-link)] hover:underline">Trade {market} →</Link> : null}
    </div>
  );
}
