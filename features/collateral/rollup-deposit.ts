import { claimInboxDepositV3, depositToInboxV3 } from "@/clients/equinox/src";
import type { TransactionPreview } from "@/lib/execution-boundary";
import { recordSignature } from "@/lib/last-signature";
import type { EquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import type { ResolvedCustodyAccounts } from "./custody-accounts";

const preview = (name: string, ix: ReturnType<typeof depositToInboxV3>): TransactionPreview => ({
  instruction: name, programId: ix.programId.toBase58(), status: "constructed",
  accounts: ix.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })),
});

/** Deposit into a delegated market: the USDC goes to the vault on Solana
 * (inbox receipt), then the rollup credits the seat. `report` narrates each step. */
export async function rollupDeposit(protocol: EquinoxProtocol, accounts: ResolvedCustodyAccounts, amount: bigint, report: (message: string) => void = () => undefined) {
  if (!accounts.v3) throw new Error("not a V3 market");
  const { core, seatShard, eventShards, authority, source, vault, mint, tokenProgram } = accounts.v3.deposit;
  report("Step 1/2 · Depositing into the vault on Solana…");
  const inbox = depositToInboxV3({ core, trader: authority, source, vault, mint, tokenProgram }, amount);
  const result = await protocol.service.executeL1(preview("DepositToInboxV3", inbox), [inbox]);
  recordSignature("DepositToInboxV3", result.signature, "l1");
  report("Step 2/2 · Crediting your seat in the MagicBlock rollup…");
  const claim = claimInboxDepositV3({ core, seatShard, eventShards, trader: authority }, accounts.seatIndex);
  const writable = [core, seatShard, ...eventShards].map(String);
  // The rollup clones the receipt from Solana; give it a moment to see the new total.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await protocol.service.executeEr(preview("ClaimInboxDepositV3", claim), [claim], writable);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
