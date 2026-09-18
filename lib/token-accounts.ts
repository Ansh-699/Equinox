import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** The custody instructions' `sourceOrDestination` account is a real SPL
 * token account the CPI transfers into/out of -- it is the trader's
 * Associated Token Account for the collateral mint, never their wallet
 * address directly (a wallet pubkey is not a token account). */
export function deriveCollateralTokenAccount(owner: string, mint: string, tokenProgram: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(tokenProgram), ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
}
