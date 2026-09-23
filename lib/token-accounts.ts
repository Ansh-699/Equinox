import { PublicKey } from "@solana/web3.js";

// Derived directly (not via @solana/spl-token, whose codecs dependency cannot
// resolve in the Workers bundle); token-accounts.test.ts pins parity.
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The custody instructions' `sourceOrDestination` account is a real SPL
 * token account the CPI transfers into/out of -- it is the trader's
 * Associated Token Account for the collateral mint, never their wallet
 * address directly (a wallet pubkey is not a token account). */
export function deriveCollateralTokenAccount(owner: string, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0].toBase58();
}
