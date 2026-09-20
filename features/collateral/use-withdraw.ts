"use client";

import { useCallback, useState } from "react";
import { withdrawCollateral, withdrawCollateralV3 } from "@/clients/stockstream/src";
import type { ResolvedCustodyAccounts } from "./custody-accounts";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { recordSignature } from "@/lib/last-signature";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";
import type { ExecutionDisplayState } from "@/lib/execution-status";
import { decodeTraderSeat, type TraderSeatView } from "@/lib/positions";
import { decodeV3SeatShard } from "@/clients/stockstream/src/abi/v3";

export interface WithdrawGate {
  allowed: boolean;
  reason?: string;
}

const RECONCILIATION_DEFICIT_STATUSES = new Set([2, 3]); // DeficitDetected, RecoveryRequired -- see MarketStateView.reconciliationStatus

/** Pure, unit-testable gate mirroring the spec's exact disable list: the
 * market must be withdrawal-safe per the indexer's own authoritative flag
 * (l1_only/commit_finalized/restored -- covers delegating/delegated/
 * commit-pending/undelegating/restoration-pending as "not safe" in one
 * check, since that IS what the flag means) and must not be in a
 * reconciliation deficit. This is a DISPLAY gate only: the on-chain
 * program's own l1_withdrawals_allowed() is the real boundary and can
 * still reject a withdrawal this gate would have allowed if state changed
 * between the read and the submission. */
export function evaluateWithdrawGate(execution: ExecutionDisplayState | null, reconciliationStatus: number | null): WithdrawGate {
  if (!execution) return { allowed: false, reason: "Execution status unavailable" };
  if (execution.degraded) return { allowed: false, reason: "Execution status reconciliation error" };
  if (!execution.withdrawalSafe) return { allowed: false, reason: "Market is delegating, delegated, committing, undelegating, or awaiting restoration" };
  if (reconciliationStatus !== null && RECONCILIATION_DEFICIT_STATUSES.has(reconciliationStatus)) {
    return { allowed: false, reason: "Vault reconciliation deficit detected" };
  }
  return { allowed: true };
}

export function useWithdraw(protocol: StockStreamProtocol | null) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submitWithdraw = useCallback(async (
    accounts: ResolvedCustodyAccounts,
    amount: bigint,
    gate: WithdrawGate,
    seat: TraderSeatView | null,
  ) => {
    if (!protocol) { setNotice("Withdraw blocked: connect a wallet capable of signing on Devnet."); return; }
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
      const result = await protocol.service.executeL1(preview, [instruction]);
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
    }
  }, [protocol]);

  return { pending, notice, submitWithdraw };
}
