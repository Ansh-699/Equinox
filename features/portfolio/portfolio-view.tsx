"use client";

import Link from "next/link";
import { Wallet } from "lucide-react";
import { TopBar, openWalletDrawer } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { V3_MARKETS } from "@/lib/v3-markets";
import { BalanceHero } from "@/features/account/account-overview";
import { PositionCard } from "@/features/account/position-card";
import { FillsList } from "@/features/activity/fills-list";
import { useRecentFills } from "@/features/activity/use-recent-fills";
import { BUTTON_PRIMARY, Card, EmptyState, formatUsdUnits, InfoTip, StatTile } from "@/components/ui/primitives";
import { useAccountSummary, type AccountSeat } from "./use-account-summary";

const AUTHORITATIVE_NOTE = "Balances are read straight from the chain: your wallet and trading account on Solana, and your margin account in each market in the MagicBlock rollup. The program stays authoritative for margin and health.";
const hasActivity = (seat: AccountSeat | null | undefined) => !!seat && (seat.position !== 0n || seat.available > 0n || seat.reserved > 0n);
const sum = (seats: (AccountSeat | null)[], pick: (s: AccountSeat) => bigint) => seats.reduce((total, s) => total + (s ? pick(s) : 0n), 0n);

export function PortfolioView() {
  const auth = useAppAuth();
  const summary = useAccountSummary(auth.walletAddress);
  const { fills } = useRecentFills(!!auth.walletAddress);
  const seats = summary.seats;
  const loading = seats === undefined && !summary.seatUnavailable;
  const list = seats ? Object.values(seats) : [];
  const active = V3_MARKETS.filter((m) => hasActivity(seats?.[m.symbol]));
  const mySeats = Object.fromEntries(Object.entries(seats ?? {}).flatMap(([symbol, seat]) => (seat ? [[symbol, seat.index]] : [])));
  const orders = list.reduce((n, s) => n + (s?.openOrderCount ?? 0), 0);
  const pnl = sum(list, (s) => s.realizedPnl);
  const feeSol = summary.trading?.sol ?? summary.wallet?.sol ?? null;

  return (
    <div className="terminal min-h-screen">
      <TopBar active="portfolio" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-[var(--t-text)]">Portfolio <InfoTip text={AUTHORITATIVE_NOTE} /></h1>
            <p className="mt-1 text-[13px] text-[var(--t-text-2)]">Your balances and positions across every market.</p>
          </div>
          <Link href="/trade" className={BUTTON_PRIMARY}>Trade</Link>
        </div>

        {!auth.walletAddress ? (
          <Card>
            <EmptyState icon={<Wallet className="h-5 w-5" />} title="Connect a wallet to see your portfolio" action={<button type="button" className={BUTTON_PRIMARY} onClick={openWalletDrawer}>Connect wallet</button>}>
              Your USDC, trading account and positions in every market show up here once a Solana wallet is connected.
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-4">
              <Card>
                <BalanceHero summary={summary} size="lg" />
                <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <StatTile label="Available to trade" value={formatUsdUnits(sum(list, (s) => s.available))} tone="up" loading={loading} hint="Free collateral, all markets" />
                  <StatTile label="In open orders" value={formatUsdUnits(sum(list, (s) => s.reserved))} loading={loading} hint={`${orders} order${orders === 1 ? "" : "s"}`} />
                  <StatTile label="Realized PnL" value={formatUsdUnits(pnl)} loading={loading} tone={pnl > 0n ? "up" : pnl < 0n ? "down" : "neutral"} hint="Closed trades" />
                  <StatTile label="SOL for fees" value={feeSol == null ? "—" : (Number(feeSol) / 1e9).toFixed(4)} loading={feeSol == null} tone={feeSol != null && feeSol < 10_000_000n ? "warn" : "neutral"} hint={summary.trading ? "Trading account" : "Wallet"} />
                </div>
              </Card>

              <Card title="Positions" action={<span className="text-[11.5px] text-[var(--t-text-3)]">{summary.delegated ? "Live on the rollup" : "Solana L1"}</span>}>
                {loading || active.length === 0 ? (
                  <PositionCard seat={loading ? undefined : null} unavailable={summary.seatUnavailable} market="TSLA-PERP" />
                ) : (
                  <div className="divide-y divide-[var(--t-border)]">
                    {active.map((m) => (
                      <div key={m.symbol} className="py-4 first:pt-0 last:pb-0">
                        <PositionCard seat={seats?.[m.symbol]} market={m.symbol} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Recent fills" action={<Link href="/activity" className="text-[12px] font-medium text-[var(--t-link)] hover:underline">View all →</Link>} bodyClassName="px-4 py-1">
                <FillsList fills={fills} mySeats={mySeats} limit={6} />
              </Card>
            </div>

            <Card as="aside" title="Accounts" className="self-start lg:sticky lg:top-4">
              <dl className="tnum space-y-2.5 text-[12.5px]">
                <div className="flex justify-between"><dt className="text-[var(--t-text-3)]">Wallet USDC</dt><dd className="text-[var(--t-text)]">{formatUsdUnits(summary.wallet?.usdc ?? (summary.wallet?.sol != null ? 0n : null))}</dd></div>
                <div className="flex justify-between"><dt className="text-[var(--t-text-3)]">Trading account USDC</dt><dd className="text-[var(--t-text)]">{summary.trading ? formatUsdUnits(summary.trading.usdc ?? 0n) : "not unlocked"}</dd></div>
                <div className="flex justify-between"><dt className="text-[var(--t-text-3)]">In margin accounts</dt><dd className="text-[var(--t-text)]">{formatUsdUnits(loading ? null : sum(list, (s) => s.available + s.reserved))}</dd></div>
              </dl>
              <p className="mt-4 text-[12px] leading-relaxed text-[var(--t-text-2)]">Margin is isolated per market. Deposit into or withdraw from a market&apos;s margin account in the terminal; withdrawals pay out to your wallet.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {V3_MARKETS.map((m) => (
                  <Link key={m.symbol} href={`/trade?market=${m.symbol}`} className="rounded-[8px] border border-[var(--t-border)] px-3 py-2 text-center text-[12px] font-medium text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">{m.symbol.replace("-PERP", "")}</Link>
                ))}
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
