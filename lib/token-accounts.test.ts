import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveCollateralTokenAccount } from "./token-accounts";

describe("deriveCollateralTokenAccount", () => {
  it("matches @solana/spl-token's own derivation, not the wallet address itself", () => {
    const owner = PublicKey.default;
    const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const expected = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
    const derived = deriveCollateralTokenAccount(owner.toBase58(), mint.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    expect(derived).toBe(expected);
    expect(derived).not.toBe(owner.toBase58());
  });
});
