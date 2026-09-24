"use client";

import type { AccountSummary } from "@/features/portfolio/use-account-summary";
import { formatUsdUnits, shortAddress, Skeleton, StatTile } from "@/components/ui/primitives";

const LOW_SOL_LAMPORTS = 10_000_000n;

/** Where the account's dollars sit: wallet, trading account and vault seat. */
export function balanceParts(summary: AccountSummary) {
  return [
    { id: "wallet", label: "Wallet", value: summary.wallet?.usdc ?? 0n, color: "var(--t-link)" },
    { id: "trading", label: "Trading account", value: summary.trading?.usdc ?? 0n, color: "var(--t-warn)" },
    { id: "vault", label: "In vault", value: summary.seat ? summary.seat.available + summary.seat.reserved : 0n, color: "var(--t-up)" },
  ];
}

/** Big total with a stacked bar showing the split across the three places. */
export function BalanceHero({ summary, size = "md" }: { summary: AccountSummary; size?: "md" | "lg" }) {
  const parts = balanceParts(summary);
  const total = parts.reduce((sum, part) => sum + part.value, 0n);
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--t-text-3)]">Total balance</div>
      <div className={`tnum mt-1 font-semibold tracking-tight text-[var(--t-text)] ${size === "lg" ? "text-[34px]" : "text-[28px]"}`}>
        {summary.totalUsdc === null ? <Skeleton className="h-[30px] w-36" /> : formatUsdUnits(summary.totalUsdc)}
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-[var(--t-surface-3)]" role="img" aria-label={parts.map((p) => `${p.label} ${formatUsdUnits(p.value)}`).join(", ")}>
        {total > 0n ? parts.map((part) => (part.value > 0n ? <div key={part.id} style={{ width: `${Number((part.value * 10_000n) / total) / 100}%`, background: part.color }} /> : null)) : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--t-text-2)]">
        {parts.map((part) => (
          <li key={part.id} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: part.color }} />
            {part.label} <span className="tnum font-medium text-[var(--t-text)]">{formatUsdUnits(part.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RollupStatusLine({ summary }: { summary: AccountSummary }) {
  const { execution, delegated } = summary;
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2.5 text-[12px]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${execution === null ? "bg-[var(--t-text-3)]" : delegated ? "bg-[var(--t-up)]" : "bg-[var(--t-warn)]"}`} />
      <span className="text-[var(--t-text-2)]">
        {execution === null ? "Checking market…" : delegated ? "Live on the MagicBlock rollup: orders fill without wallet popups." : "Market on Solana L1: accounts, deposits and withdrawals open."}
      </span>
    </div>
  );
}

/** Wallet, trading account and vault as tiles. */
export function AccountOverview({ summary }: { summary: AccountSummary }) {
  const sol = summary.wallet?.sol ?? null;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-[12px] font-semibold text-[var(--t-text-2)]">Your wallet</h3>
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="USDC" value={formatUsdUnits(summary.wallet?.usdc)} hint="Ready to deposit" loading={summary.wallet?.usdc === null} />
          <StatTile label="SOL" value={sol === null ? "—" : (Number(sol) / 1e9).toFixed(4)} hint={sol !== null && sol < LOW_SOL_LAMPORTS ? "Low: top up for fees" : "For network fees"} tone={sol !== null && sol < LOW_SOL_LAMPORTS ? "warn" : "neutral"} loading={sol === null} />
        </div>
      </div>
      {summary.trading ? (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-[var(--t-text-2)]">Trading account <span className="font-mono font-normal text-[var(--t-text-3)]">{shortAddress(summary.trading.address)}</span></h3>
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="USDC" value={formatUsdUnits(summary.trading.usdc)} hint="Signs trades silently" />
            <StatTile label="SOL" value={summary.trading.sol === null ? "—" : (Number(summary.trading.sol) / 1e9).toFixed(4)} hint="Fees" />
          </div>
        </div>
      ) : null}
      <div>
        <h3 className="mb-2 text-[12px] font-semibold text-[var(--t-text-2)]">Vault · TSLA-PERP</h3>
        {summary.seat === undefined && summary.seatUnavailable ? (
          <p className="rounded-[8px] border border-[var(--t-border)] px-3 py-3 text-[12px] text-[var(--t-text-2)]">Couldn&apos;t read the vault right now. Retrying every few seconds.</p>
        ) : summary.seat === undefined ? (
          <div className="grid grid-cols-2 gap-2"><StatTile label="Available" value="" loading /><StatTile label="In orders" value="" loading /></div>
        ) : summary.seat === null ? (
          <p className="rounded-[8px] border border-dashed border-[var(--t-border-strong)] px-3 py-3 text-[12px] leading-relaxed text-[var(--t-text-2)]">No margin account yet. Press <b className="text-[var(--t-text)]">Start trading</b> on the Trade page: it funds your trading account, opens a margin account and deposits in one go.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Available" value={formatUsdUnits(summary.seat.available)} hint="Free to trade" tone="up" />
            <StatTile label="In orders" value={formatUsdUnits(summary.seat.reserved)} hint={`${summary.seat.openOrderCount} open order${summary.seat.openOrderCount === 1 ? "" : "s"}`} />
          </div>
        )}
      </div>
      <RollupStatusLine summary={summary} />
    </div>
  );
}
