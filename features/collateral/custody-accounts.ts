import type { CustodyAccounts } from "@/clients/stockstream/src";
import type { PerpMarketConfig } from "@/lib/markets";
import { deriveCollateralTokenAccount } from "@/lib/token-accounts";

/** Shared by deposit/withdraw everywhere they're offered (trade terminal,
 * portfolio) so there is exactly one place that resolves these accounts --
 * no duplicate PDA/ATA derivation scattered across pages. */
export function resolveCustodyAccounts(walletAddress: string | null, marketAddress: string | null, marketConfig: PerpMarketConfig): CustodyAccounts | null {
  if (!walletAddress || !marketAddress) return null;
  const mint = process.env.NEXT_PUBLIC_STOCKSTREAM_COLLATERAL_MINT;
  const tokenProgram = process.env.NEXT_PUBLIC_STOCKSTREAM_TOKEN_PROGRAM;
  const vault = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT ?? marketConfig.vaultPda;
  const vaultAuthority = process.env.NEXT_PUBLIC_STOCKSTREAM_VAULT_AUTHORITY;
  if (!mint || !tokenProgram || !vault || !vaultAuthority) return null;
  const sourceOrDestination = deriveCollateralTokenAccount(walletAddress, mint, tokenProgram);
  return { market: marketAddress, authority: walletAddress, seatIndex: 0, sourceOrDestination, mint, tokenProgram, vault, vaultAuthority };
}
