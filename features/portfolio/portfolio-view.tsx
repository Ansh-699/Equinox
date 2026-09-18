"use client";

import { useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { useStockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import { usePosition } from "@/features/positions/use-position";
import { PositionsPanel } from "@/features/positions/positions-panel";
import { useDeposit } from "@/features/collateral/use-deposit";
import { useWithdraw, evaluateWithdrawGate } from "@/features/collateral/use-withdraw";
import { resolveCustodyAccounts } from "@/features/collateral/custody-accounts";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { useWalletBalances } from "./use-wallet-balances";
import { marketForSymbol } from "@/lib/markets";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";

const marketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL;

function formatLamports(lamports: bigint | null): string {
  if (lamports === null) return "--";
  return `${(Number(lamports) / 1_000_000_000).toFixed(4)} SOL`;
}

export function PortfolioView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useStockStreamProtocol(auth.authenticated ? marketAddress : null);
  const position = usePosition(protocol?.rpc ?? null, marketAddress, 0);
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const deposit = useDeposit(protocol);
  const withdraw = useWithdraw(protocol);
  const withdrawGate = evaluateWithdrawGate(executionStatus, position.reconciliationStatus);
  const [amount, setAmount] = useState("100");

  const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
  const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
  const collateralTokenAccount = auth.walletAddress && mint && tokenProgram ? deriveCollateralTokenAccount(auth.walletAddress, mint, tokenProgram) : null;
  const balances = useWalletBalances(protocol?.rpc ?? null, auth.walletAddress, collateralTokenAccount);

  const notice = withdraw.notice ?? deposit.notice;
  const estimatedBuffer = position.seat ? position.seat.availableCollateral - position.seat.reservedMargin : null;

  return (
    <main className="shell">
      <TopBar active="portfolio" auth={auth} />
      <div className="portfolio-grid">
        <section className="session-panel">
          <div className="panel-title"><h2>Wallet balances</h2><span>Devnet</span></div>
          <dl className="session-detail">
            <dt>SOL</dt><dd>{formatLamports(balances.solLamports)}</dd>
            <dt>Collateral token account</dt><dd>{balances.collateralTokenBalance !== null ? `${balances.collateralTokenBalance} base units` : "--"}</dd>
          </dl>
        </section>

        <PositionsPanel seat={position.seat} error={position.error} />

        <section className="session-panel">
          <div className="panel-title"><h2>Margin and funding</h2><span>Raw fields</span></div>
          {position.seat ? (
            <dl className="session-detail">
              <dt>Reserved margin</dt><dd>{position.seat.reservedMargin.toString()}</dd>
              <dt>Realized PnL</dt><dd>{position.seat.realizedPnl.toString()}</dd>
              <dt>Last funding accumulator</dt><dd>{position.seat.lastFundingAccumulator.toString()}</dd>
              <dt>Estimated buffer (not authoritative)</dt><dd>{estimatedBuffer !== null ? estimatedBuffer.toString() : "--"}</dd>
            </dl>
          ) : (
            <p className="form-note">No trader seat found for this market.</p>
          )}
          <p className="form-note">Unrealized PnL and equity need the verified oracle mark price and are not computed client-side. The program remains authoritative.</p>
        </section>

        <section className="session-panel">
          <div className="panel-title"><h2>Deposit / withdraw</h2><span>Main wallet only</span></div>
          <label>Amount (base units)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" /></label>
          <div className="lifecycle-actions">
            <button
              disabled={deposit.pending}
              onClick={() => {
                const accounts = resolveCustodyAccounts(auth.walletAddress, marketAddress, marketConfig);
                if (!accounts) return;
                void deposit.submitDeposit(accounts, BigInt(amount || "0"));
              }}
            >
              {deposit.pending ? "Depositing…" : "Deposit"}
            </button>
            <button
              disabled={!withdrawGate.allowed || withdraw.pending}
              title={!withdrawGate.allowed ? withdrawGate.reason : undefined}
              onClick={() => {
                const accounts = resolveCustodyAccounts(auth.walletAddress, marketAddress, marketConfig);
                if (!accounts) return;
                void withdraw.submitWithdraw(accounts, BigInt(amount || "0"), withdrawGate, position.seat);
              }}
            >
              {withdraw.pending ? "Withdrawing…" : "Withdraw"}
            </button>
          </div>
          {!withdrawGate.allowed ? <p className="form-note negative">Withdrawals disabled: {withdrawGate.reason}</p> : null}
          {notice ? <p className="form-note">{notice}</p> : null}
        </section>
      </div>
    </main>
  );
}
