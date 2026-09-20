import type { CustodyAccounts, V3DepositAccounts, V3WithdrawAccounts } from "@/clients/stockstream/src";
import type { PerpMarketConfig } from "@/lib/markets";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";
import { deriveV3ExecutionAccounts } from "@/clients/stockstream/src";

export type ResolvedCustodyAccounts = CustodyAccounts & {
  v3?: { deposit: V3DepositAccounts; withdraw: V3WithdrawAccounts };
};

/** Shared by deposit/withdraw everywhere they're offered (trade terminal,
 * portfolio) so there is exactly one place that resolves these accounts --
 * no duplicate PDA/ATA derivation scattered across pages. */
export function resolveCustodyAccounts(walletAddress: string | null, marketAddress: string | null, marketConfig: PerpMarketConfig): ResolvedCustodyAccounts | null {
  if (!walletAddress || !marketAddress) return null;
  const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
  const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
  const vault = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT ?? marketConfig.vaultPda;
  const vaultAuthority = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY;
  if (!mint || !tokenProgram || !vault || !vaultAuthority) return null;
  const sourceOrDestination = deriveCollateralTokenAccount(walletAddress, mint, tokenProgram);
  const legacy = { market: marketAddress, authority: walletAddress, seatIndex: 0, sourceOrDestination, mint, tokenProgram, vault, vaultAuthority } satisfies CustodyAccounts;
  const v3Core = process.env.NEXT_PUBLIC_STOCKSTREAM_V3_CORE_ADDRESS;
  if (!v3Core) return legacy;
  const execution = deriveV3ExecutionAccounts(v3Core, walletAddress);
  const v3 = {
    deposit: { core: v3Core, seatShard: execution.seatShards[0], eventShards: execution.eventShards, authority: walletAddress, source: sourceOrDestination, vault, mint, tokenProgram },
    withdraw: { ...execution, destination: sourceOrDestination, mint, vault, vaultAuthority, tokenProgram },
  } satisfies { deposit: V3DepositAccounts; withdraw: V3WithdrawAccounts };
  return { ...legacy, v3 };
}
