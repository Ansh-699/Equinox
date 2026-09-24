"use client";

import { useMemo, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useEquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { useV3Book } from "@/features/trading/use-v3-book";
import { seatFromPositions } from "@/features/trading/rollup-seat";
import { usePosition } from "@/features/positions/use-position";
import { useDeposit } from "@/features/collateral/use-deposit";
import { useWithdraw, evaluateWithdrawGate } from "@/features/collateral/use-withdraw";
import { resolveCustodyAccounts } from "@/features/collateral/custody-accounts";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { refreshWalletBalances } from "./use-wallet-balances";
import { ACCOUNT_MARKET, useAccountSummary } from "./use-account-summary";
import { marketForSymbol } from "@/lib/markets";
import { toCollateralUnits } from "@/features/trading/lifecycle-panel";
import { openWalletDrawer } from "@/components/layout/top-bar";
import { BalanceHero } from "@/features/account/account-overview";
import { PositionCard } from "@/features/account/position-card";
import { ActivityFeed } from "@/features/account/activity-list";
import { useMarketEvents } from "@/features/activity/use-market-events";
import { BUTTON_PRIMARY, Card, EmptyState, formatUsdUnits, InfoTip, SegmentedTabs, StatTile } from "@/components/ui/primitives";
import Link from "next/link";
import { Wallet } from "lucide-react";

const marketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL;

const AUTHORITATIVE_NOTE = "Balances are read straight from the chain. Equity and unrealized PnL need the verified oracle mark price and the program's own risk formula, so they are not estimated here; the program stays authoritative for margin and health.";

export function PortfolioView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_EQUINOX_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_EQUINOX_MARKET_ADDRESS ?? marketConfig.marketPda;
  // Same identity as the Trade page: the in-app trading key, once unlocked there.
  const tradingKey = useTradingKey(auth);
  const trader = tradingKey.signer?.address ?? auth.walletAddress;
  const protocol = useEquinoxProtocol(auth.authenticated ? marketAddress : null, tradingKey.signer);
  const v3Core = process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS;
  const l1Position = usePosition(protocol?.rpc ?? null, marketAddress, 0, { marketApiUrl, core: v3Core, ...(v3Core ? { trader: trader ?? null } : {}) });
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  // While delegated the rollup holds the live seat.
  const delegated = !!executionStatus?.marketDelegated;
  const book = useV3Book(marketApiUrl, v3Core || undefined, executionStatus ? delegated : null);
  const rollupSeat = useMemo(() => (delegated && trader && book.updatedAt !== null ? seatFromPositions(book.positions, trader) : null), [delegated, trader, book.positions, book.updatedAt]);
  const position = delegated && rollupSeat ? { ...l1Position, seat: rollupSeat.view as NonNullable<typeof l1Position.seat> } : l1Position;
  const seatIndex = delegated && rollupSeat ? rollupSeat.index : l1Position.seatIndex ?? 0;
  const deposit = useDeposit(protocol);
  const withdraw = useWithdraw(protocol);
  const l1Gate = evaluateWithdrawGate(executionStatus, position.reconciliationStatus);
  const withdrawGate = delegated && !executionStatus?.commitPending ? { allowed: true } : l1Gate;
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const summary = useAccountSummary(auth.walletAddress);
  const { events } = useMarketEvents(marketApiUrl, marketSymbol);

  const notice = withdraw.notice ?? deposit.notice;
  const units = toCollateralUnits(amount);
  // Deposits come from whichever account signs (the trading account once unlocked).
  const depositSource = summary.trading?.usdc ?? summary.wallet?.usdc ?? null;
  const available = summary.seat?.available ?? null;
  const max = mode === "deposit" ? depositSource : available;
  const after = available === null ? null : units === null ? available : mode === "deposit" ? available + units : available - units;
  const overMax = units !== null && max !== null && units > max;
  const pending = mode === "deposit" ? deposit.pending : withdraw.pending;
  const blocked = mode === "withdraw" && !withdrawGate.allowed;
  const setFraction = (fraction: bigint) => { if (max !== null) setAmount((Number((max * fraction) / 100n) / 1e6).toFixed(2)); };

  function submit() {
    const accounts = resolveCustodyAccounts(trader, marketAddress, marketConfig, seatIndex);
    if (!accounts || units === null) return;
    if (mode === "deposit") void deposit.submitDeposit(accounts, units, delegated).then(refreshWalletBalances);
    else void withdraw.submitWithdraw(accounts, units, withdrawGate, position.seat, delegated && !executionStatus?.commitPending, tradingKey.signer ? auth.walletAddress : null).then(refreshWalletBalances);
  }

  const seat = summary.seat;
  const seatLoading = seat === undefined && !summary.seatUnavailable;
  return (
    <div className="terminal min-h-screen">
      <TopBar active="portfolio" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-[var(--t-text)]">Portfolio <InfoTip text={AUTHORITATIVE_NOTE} /></h1>
            <p className="mt-1 text-[13px] text-[var(--t-text-2)]">Your balances, vault collateral and open position on {ACCOUNT_MARKET}.</p>
          </div>
          <Link href="/trade" className={BUTTON_PRIMARY}>Trade</Link>
        </div>

        {!auth.walletAddress ? (
          <Card>
            <EmptyState icon={<Wallet className="h-5 w-5" />} title="Connect a wallet to see your portfolio" action={<button type="button" className={BUTTON_PRIMARY} onClick={openWalletDrawer}>Connect wallet</button>}>
              Your USDC, trading account and vault seat show up here once a Solana wallet is connected.
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <div className="min-w-0 space-y-4">
              <Card>
                <BalanceHero summary={summary} size="lg" />
                <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <StatTile label="Available to trade" value={formatUsdUnits(seat?.available)} tone="up" loading={seatLoading} hint="Free vault collateral" />
                  <StatTile label="In open orders" value={formatUsdUnits(seat?.reserved)} loading={seatLoading} hint={seat ? `${seat.openOrderCount} order${seat.openOrderCount === 1 ? "" : "s"}` : undefined} />
                  <StatTile label="Realized PnL" value={formatUsdUnits(seat?.realizedPnl)} loading={seatLoading} tone={seat && seat.realizedPnl > 0n ? "up" : seat && seat.realizedPnl < 0n ? "down" : "neutral"} hint="Closed trades" />
                  <StatTile label="Wallet SOL" value={summary.wallet?.sol == null ? "—" : (Number(summary.wallet.sol) / 1e9).toFixed(4)} loading={summary.wallet?.sol == null} tone={summary.wallet?.sol != null && summary.wallet.sol < 10_000_000n ? "warn" : "neutral"} hint="Network fees" />
                </div>
              </Card>

              <Card title="Position" action={<span className="text-[11.5px] text-[var(--t-text-3)]">{delegated ? "Live on the rollup" : "Solana L1"}</span>}>
                <PositionCard seat={seat} unavailable={summary.seatUnavailable} market={ACCOUNT_MARKET} />
              </Card>

              <Card title="Recent market activity" action={<Link href="/activity" className="text-[12px] font-medium text-[var(--t-link)] hover:underline">View all →</Link>} bodyClassName="px-4 py-1">
                <ActivityFeed events={events} limit={5} />
              </Card>
            </div>

            <Card as="aside" title={mode === "deposit" ? "Add funds to the vault" : "Withdraw to your wallet"} className="self-start lg:sticky lg:top-4">
              <SegmentedTabs label="Deposit or withdraw" tabs={[{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }]} value={mode} onChange={(next) => { setMode(next); setAmount(""); }} />
              <label className="mt-4 block text-[12px] font-medium text-[var(--t-text-2)]" htmlFor="collateral-amount">Amount</label>
              <div className="mt-1.5 flex h-[44px] items-center rounded-[8px] border border-[var(--t-border-strong)] bg-[var(--t-bg)] px-3 focus-within:outline focus-within:outline-2 focus-within:outline-[var(--t-up)]">
                <span className="text-[16px] text-[var(--t-text-3)]">$</span>
                <input id="collateral-amount" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00" autoComplete="off"
                  className="tnum h-full min-w-0 flex-1 bg-transparent px-1.5 text-[18px] font-semibold text-[var(--t-text)] outline-none" />
                <span className="text-[12px] font-medium text-[var(--t-text-3)]">USDC</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                {[25n, 50n, 100n].map((fraction) => (
                  <button key={String(fraction)} type="button" disabled={max === null || max === 0n} onClick={() => setFraction(fraction)}
                    className="h-[26px] flex-1 rounded-[6px] border border-[var(--t-border)] text-[11.5px] font-medium text-[var(--t-text-2)] hover:border-[var(--t-border-strong)] hover:text-[var(--t-text)] disabled:opacity-50">
                    {fraction === 100n ? "Max" : `${fraction}%`}
                  </button>
                ))}
              </div>
              <dl className="tnum mt-4 space-y-1.5 text-[12px]">
                <div className="flex justify-between"><dt className="text-[var(--t-text-3)]">{mode === "deposit" ? "From your account" : "In the vault"}</dt><dd className="text-[var(--t-text)]">{formatUsdUnits(max)}</dd></div>
                <div className="flex justify-between"><dt className="text-[var(--t-text-3)]">Available after</dt><dd className={after !== null && after < 0n ? "text-[var(--t-down)]" : "text-[var(--t-text)]"}>{formatUsdUnits(after)}</dd></div>
              </dl>
              <button type="button" className={`${BUTTON_PRIMARY} mt-4 w-full`} disabled={pending || units === null || overMax || blocked} onClick={submit}>
                {pending ? (mode === "deposit" ? "Depositing…" : "Withdrawing…") : units === null ? "Enter an amount" : overMax ? "Amount too high" : `${mode === "deposit" ? "Deposit" : "Withdraw"} ${formatUsdUnits(units)}`}
              </button>
              {blocked ? <p className="mt-3 rounded-[8px] bg-[rgba(245,158,11,0.1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--t-warn)]">Withdrawals are paused right now: {withdrawGate.reason?.toLowerCase()}. They reopen automatically.</p> : null}
              {notice ? <p role="status" className="mt-3 text-[12px] leading-relaxed text-[var(--t-text-2)]">{notice}</p> : null}
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
