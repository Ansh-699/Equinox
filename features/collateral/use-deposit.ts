"use client";

import { useCallback, useState } from "react";
import { depositCollateral, type CustodyAccounts } from "@/clients/stockstream/src";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { RpcFailure } from "@/lib/rpc-transport";
import { recordSignature } from "@/lib/last-signature";
import type { StockStreamProtocol } from "@/features/wallet/use-stockstream-protocol";

export function useDeposit(protocol: StockStreamProtocol | null) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submitDeposit = useCallback(async (accounts: CustodyAccounts, amount: bigint) => {
    if (!protocol) { setNotice("Deposit blocked: connect a wallet capable of signing on Devnet."); return; }
    if (amount <= 0n) { setNotice("Deposit blocked: enter a positive amount."); return; }
    const instruction = depositCollateral(accounts, amount);
    const preview: TransactionPreview = {
      instruction: "DepositCollateral",
      programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
      status: "constructed",
    };
    setPending(true);
    setNotice(`Simulating DepositCollateral for ${amount} base units…`);
    try {
      const result = await protocol.service.executeL1(preview, [instruction]);
      recordSignature("DepositCollateral", result.signature, "l1");
      const vaultBalance = await protocol.rpc.tokenBalance(String(accounts.vault)).catch(() => null);
      setNotice(`DepositCollateral ${result.confirmation} — signature ${result.signature.slice(0, 8)}…${result.signature.slice(-8)}.${vaultBalance !== null ? ` Vault balance (readback): ${vaultBalance} base units.` : ""}`);
    } catch (error) {
      setNotice(error instanceof RpcFailure ? `DepositCollateral failed at ${error.method} (${error.code}).` : error instanceof Error ? error.message : "Deposit failed");
    } finally {
      setPending(false);
    }
  }, [protocol]);

  return { pending, notice, submitDeposit };
}
