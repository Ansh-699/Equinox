"use client";

import { useCallback, useState } from "react";
import { depositCollateral, depositCollateralV3 } from "@/clients/equinox/src";
import { rollupDeposit } from "./rollup-deposit";
import type { ResolvedCustodyAccounts } from "./custody-accounts";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { refreshWalletBalances } from "@/features/portfolio/use-wallet-balances";
import { recordSignature } from "@/lib/last-signature";
import type { EquinoxProtocol } from "@/features/wallet/use-equinox-protocol";

export function useDeposit(protocol: EquinoxProtocol | null, report?: (message: string) => void) {
  const [pending, setPending] = useState(false);
  const [notice, setNoticeState] = useState<string | null>(null);
  // Mirrors every status into the caller's single status line.
  const setNotice = useCallback((message: string) => { setNoticeState(message); report?.(message); }, [report]);

  /** `inRollup`: the market is delegated, so the deposit goes through the
   * inbox (L1 transfer + receipt), then the rollup credits the seat. */
  const submitDeposit = useCallback(async (accounts: ResolvedCustodyAccounts, amount: bigint, inRollup = false) => {
    if (!protocol) { setNotice("Deposit blocked: connect a wallet capable of signing on Devnet."); return; }
    if (amount <= 0n) { setNotice("Deposit blocked: enter a positive amount."); return; }
    if (inRollup && accounts.v3) {
      setPending(true);
      try {
        await rollupDeposit(protocol, accounts, amount, setNotice);
        setNotice(`Deposited ${Number(amount) / 1e6} USDC — credited to your seat in the rollup.`);
      } catch (error) {
        setNotice(`Deposit not completed: ${error instanceof Error ? error.message : String(error)}. Tokens already in the vault stay on your receipt and are credited on the next deposit.`);
      } finally {
        setPending(false);
        refreshWalletBalances();
      }
      return;
    }
    const instruction = accounts.v3 ? depositCollateralV3(accounts.v3.deposit, accounts.seatIndex, amount) : depositCollateral(accounts, amount);
    const preview: TransactionPreview = {
      instruction: "DepositCollateral",
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
      status: "constructed",
    };
    setPending(true);
    setNotice(`Simulating DepositCollateral for ${amount} base units…`);
    try {
      const result = await protocol.service.executeL1(preview, [instruction], { freshOracle: true });
      recordSignature("DepositCollateral", result.signature, "l1");
      const vaultBalance = await protocol.rpc.tokenBalance(String(accounts.vault)).catch(() => null);
      setNotice(`DepositCollateral ${result.confirmation} — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.${vaultBalance !== null ? ` Vault balance (readback): ${vaultBalance} base units.` : ""}`);
    } catch (error) {
      setNotice(error instanceof RpcFailure ? `DepositCollateral failed at ${error.method} (${error.code}).` : error instanceof Error ? error.message : "Deposit failed");
    } finally {
      setPending(false);
      refreshWalletBalances();
    }
  }, [protocol, setNotice]);

  return { pending, notice, submitDeposit };
}
