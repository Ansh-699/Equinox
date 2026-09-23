"use client";

import { useCallback, useState } from "react";
import { claimInboxDepositV3, depositCollateral, depositCollateralV3, depositToInboxV3 } from "@/clients/stockstream/src";
import type { ResolvedCustodyAccounts } from "./custody-accounts";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { refreshWalletBalances } from "@/features/portfolio/use-wallet-balances";
import { recordSignature } from "@/lib/last-signature";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";

export function useDeposit(protocol: StockStreamProtocol | null, report?: (message: string) => void) {
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
      const { core, seatShard, eventShards, authority, source, vault, mint, tokenProgram } = accounts.v3.deposit;
      const toPreview = (name: string, ix: ReturnType<typeof depositToInboxV3>): TransactionPreview => ({
        instruction: name, programId: ix.programId.toBase58(), status: "constructed",
        accounts: ix.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
      });
      setPending(true);
      try {
        setNotice("Step 1/2 · Depositing into the vault on Solana…");
        const inbox = depositToInboxV3({ core, trader: authority, source, vault, mint, tokenProgram }, amount);
        const result = await protocol.service.executeL1(toPreview("DepositToInboxV3", inbox), [inbox]);
        recordSignature("DepositToInboxV3", result.signature, "l1");
        setNotice("Step 2/2 · Crediting your seat in the MagicBlock rollup…");
        const claim = claimInboxDepositV3({ core, seatShard, eventShards, trader: authority }, accounts.seatIndex);
        const writable = [core, seatShard, ...eventShards].map(String);
        // The rollup clones the receipt from L1; give it a moment to see the new total.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await protocol.service.executeEr(toPreview("ClaimInboxDepositV3", claim), [claim], writable);
            break;
          } catch (error) {
            if (attempt >= 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
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
