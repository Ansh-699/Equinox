"use client";

import { useCallback, useState } from "react";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { claimWithdrawalV3, deriveMagicFeeVault, requestWithdrawalV3, withdrawCollateral, withdrawCollateralV3 } from "@/clients/stockstream/src";
import deployment from "@/config/stockstream-deployment.json";
import type { ResolvedCustodyAccounts } from "./custody-accounts";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { refreshWalletBalances } from "@/features/portfolio/use-wallet-balances";
import { recordSignature } from "@/lib/last-signature";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import type { ExecutionDisplayState } from "@/lib/execution-status";
import { decodeTraderSeat, type TraderSeatView } from "@/lib/positions";
import { decodeV3SeatShard } from "@/clients/stockstream/src/abi/v3";

export interface WithdrawGate {
  allowed: boolean;
  reason?: string;
}

const RECONCILIATION_SAFE_STATUS = 0; // Reconciled -- matches validate_v3_withdrawal_readiness

/** Pure, unit-testable gate mirroring the spec's exact disable list: the
 * market must be withdrawal-safe per the indexer's own authoritative flag
 * (l1_only/commit_finalized/restored -- covers delegating/delegated/
 * commit-pending/undelegating/restoration-pending as "not safe" in one
 * check, since that IS what the flag means) and must have a confirmed
 * reconciled vault. This is a DISPLAY gate only: the on-chain
 * program's own l1_withdrawals_allowed() is the real boundary and can
 * still reject a withdrawal this gate would have allowed if state changed
 * between the read and the submission. */
export function evaluateWithdrawGate(execution: ExecutionDisplayState | null, reconciliationStatus: number | null): WithdrawGate {
  if (!execution) return { allowed: false, reason: "Execution status unavailable" };
  if (execution.degraded) return { allowed: false, reason: "Execution status reconciliation error" };
  if (!execution.withdrawalSafe) return { allowed: false, reason: "Market is delegating, delegated, committing, undelegating, or awaiting restoration" };
  if (reconciliationStatus !== null && reconciliationStatus !== RECONCILIATION_SAFE_STATUS) {
    return { allowed: false, reason: "Vault reconciliation is not confirmed" };
  }
  return { allowed: true };
}

export function useWithdraw(protocol: StockStreamProtocol | null, report?: (message: string) => void) {
  const [pending, setPending] = useState(false);
  const [notice, setNoticeState] = useState<string | null>(null);
  // Mirrors every status into the caller's single status line.
  const setNotice = useCallback((message: string) => { setNoticeState(message); report?.(message); }, [report]);

  const submitWithdraw = useCallback(async (
    accounts: ResolvedCustodyAccounts,
    amount: bigint,
    gate: WithdrawGate,
    seat: TraderSeatView | null,
    inRollup = false,
    /** Pay out to this wallet's USDC account instead (the trading key's owner). */
    payoutOwner: string | null = null,
  ) => {
    if (!protocol) { setNotice("Withdraw blocked: connect a wallet capable of signing on Devnet."); return; }
    if (inRollup && accounts.v3) {
      if (amount <= 0n) { setNotice("Withdraw blocked: enter a positive amount."); return; }
      if (seat && amount > seat.availableCollateral) { setNotice("Withdraw blocked: amount exceeds your free collateral."); return; }
      const w = accounts.v3.withdraw;
      const seatShard = w.seatShards[Math.floor(accounts.seatIndex / 32)];
      if (!w.oracleSnapshot) { setNotice("Withdraw blocked: no oracle snapshot configured."); return; }
      const toPreview = (name: string, ixs: readonly { programId: { toBase58(): string }; keys: readonly { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[] }[]): TransactionPreview => {
        const ix = ixs[ixs.length - 1];
        return { instruction: name, programId: ix.programId.toBase58(), status: "constructed", accounts: ix.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })) };
      };
      setPending(true);
      try {
        // TraderSeat.reserved[8..16] (shard header 44, seat 256, offset 192): total requested so far.
        const requestedOnL1 = async () => {
          const bytes = await protocol.rpc.rawAccountBytes(String(seatShard));
          if (!bytes) throw new Error("seat shard not found on Solana");
          return new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(44 + (accounts.seatIndex % 32) * 256 + 192, true);
        };
        const target = (await requestedOnL1()) + amount;
        // Step 1: the rollup debits the seat (risk-checked) and commits the shard to Solana.
        setNotice("Step 1/2 · Requesting the withdrawal in the MagicBlock rollup…");
        const request = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
          // The core pays the shard commit through the fee vault: trader-paid commits stop at 10 per delegation.
          requestWithdrawalV3({ core: w.core, seatShard, eventShards: w.eventShards, trader: w.authority, oracleSnapshot: w.oracleSnapshot, feeVault: deriveMagicFeeVault(deployment.magicBlock.validator) }, accounts.seatIndex, amount)];
        // Withdrawals never wait for a live price: with none (weekend, outage) the
        // program uses the last verified one, stressed against any open position.
        await protocol.service.executeEr(toPreview("RequestWithdrawalV3", request), request, [w.core, seatShard, ...w.eventShards].map(String), { oracle: "best-effort" });
        // The commit usually lands on Solana in < 1 s; wait up to 45 s before signing the payout.
        setNotice("Step 2/2 · Waiting for the rollup commit on Solana…");
        const deadline = Date.now() + 45_000;
        while ((await requestedOnL1().catch(() => 0n)) < target) {
          if (Date.now() > deadline) throw new Error("the rollup commit has not reached Solana yet — press Withdraw again later to collect it");
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
        setNotice("Step 2/2 · Paying out from the vault on Solana…");
        // The vault pays the trader's own USDC account (the program insists); for a
        // trading key, the same transaction forwards it to the owner's wallet.
        const claim = claimWithdrawalV3({ core: w.core, seatShard, trader: w.authority, destination: w.destination, vault: w.vault, vaultAuthority: w.vaultAuthority, mint: w.mint, tokenProgram: w.tokenProgram }, accounts.seatIndex);
        const payoutIxs = [claim];
        if (payoutOwner) {
          const mint = new PublicKey(String(w.mint)), tokenProgram = new PublicKey(String(w.tokenProgram)), trader = new PublicKey(String(w.authority));
          const payout = getAssociatedTokenAddressSync(mint, new PublicKey(payoutOwner), false, tokenProgram);
          payoutIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(trader, payout, new PublicKey(payoutOwner), mint, tokenProgram),
            createTransferCheckedInstruction(new PublicKey(String(w.destination)), mint, payout, trader, amount, 6, [], tokenProgram),
          );
        }
        const result = await protocol.service.executeL1(toPreview("ClaimWithdrawalV3", payoutIxs), payoutIxs);
        recordSignature("ClaimWithdrawalV3", result.signature, "l1");
        setNotice(`Withdrew ${Number(amount) / 1e6} USDC to ${payoutOwner ? "your wallet" : "your USDC account"}.`);
      } catch (error) {
        setNotice(`Withdraw not completed: ${error instanceof Error ? error.message : String(error)}. A requested amount that was not paid out is paid by the next withdrawal.`);
      } finally {
        setPending(false);
        refreshWalletBalances();
      }
      return;
    }
    if (!gate.allowed) { setNotice(`Withdraw blocked: ${gate.reason ?? "market lifecycle state"}.`); return; }
    if (amount <= 0n) { setNotice("Withdraw blocked: enter a positive amount."); return; }
    if (seat && amount > seat.availableCollateral) {
      setNotice(`Withdraw blocked: ${amount} exceeds available collateral (${seat.availableCollateral}). This is a display check only -- the program remains authoritative.`);
      return;
    }
    const instruction = accounts.v3 ? withdrawCollateralV3(accounts.v3.withdraw, accounts.seatIndex, amount) : withdrawCollateral(accounts, amount);
    const preview: TransactionPreview = {
      instruction: "WithdrawCollateral",
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
      status: "constructed",
    };
    setPending(true);
    setNotice(`Simulating WithdrawCollateral for ${amount} base units…`);
    try {
      const result = await protocol.service.executeL1(preview, [instruction], { freshOracle: true });
      recordSignature("WithdrawCollateral", result.signature, "l1");
      const [vaultBalance, destinationBalance, readbackSeat] = await Promise.all([
        protocol.rpc.tokenBalance(String(accounts.vault)).catch(() => null),
        protocol.rpc.tokenBalance(String(accounts.sourceOrDestination)).catch(() => null),
        accounts.v3
          ? protocol.rpc.accountBytes(String(accounts.v3.withdraw.seatShards[Math.floor(accounts.seatIndex / 32)]))
            .then((bytes) => decodeV3SeatShard(bytes)?.positions.find((position) => position.slot === accounts.seatIndex % 32) ?? null)
            .catch(() => null)
          : protocol.rpc.market(String(accounts.market)).then((market) => decodeTraderSeat(market.bytes, market.state.traderSeatOffset, accounts.seatIndex)).catch(() => null),
      ]);
      setNotice(
        `WithdrawCollateral ${result.confirmation} — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.` +
        (vaultBalance !== null ? ` Vault (readback): ${vaultBalance}.` : "") +
        (destinationBalance !== null ? ` Destination token account (readback): ${destinationBalance}.` : "") +
        (readbackSeat !== null ? ` Trader collateral (readback): ${readbackSeat.availableCollateral}.` : ""),
      );
    } catch (error) {
      setNotice(error instanceof RpcFailure ? `WithdrawCollateral failed at ${error.method} (${error.code}) -- the program may have rejected the current health/lifecycle state.` : error instanceof Error ? error.message : "Withdraw failed");
    } finally {
      setPending(false);
      refreshWalletBalances();
    }
  }, [protocol, setNotice]);

  return { pending, notice, submitWithdraw };
}
