import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, AccountState, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { confirmSignature, heldTokens } from "./dbc-launch";

const rpc = (...statuses: unknown[]) => ({ getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [statuses.length > 1 ? statuses.shift() : statuses[0]] }) }) as never;

describe("confirmSignature", () => {
  it("waits through unseen and processed until confirmed", async () => {
    await expect(confirmSignature(rpc(null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }), "sig", 1_000, 1)).resolves.toBeUndefined();
  });
  it("accepts finalized", async () => {
    await expect(confirmSignature(rpc({ confirmationStatus: "finalized", err: null }), "sig", 1_000, 1)).resolves.toBeUndefined();
  });
  it("throws the on-chain error", async () => {
    await expect(confirmSignature(rpc({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }), "sig", 1_000, 1)).rejects.toThrow("InstructionError");
  });
  it("gives up after the timeout and points at the explorer", async () => {
    await expect(confirmSignature(rpc(null), "sig", 20, 1)).rejects.toThrow(/not confirmed within .* check sig/);
  });
});

describe("heldTokens", () => {
  const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
  // Serves one SPL token account, only at the owner's associated address.
  const chain = (amount: bigint | null) => ({
    getAccountInfo: async (address: PublicKey) => {
      if (amount === null || !address.equals(getAssociatedTokenAddressSync(mint, owner))) return null;
      const data = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
      return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
    },
  });
  it("reads the raw amount as whole tokens", async () => {
    expect(await heldTokens(chain(1_234_567n), mint, owner)).toBe(1.234567);
  });
  it("is 0 when the owner has no account", async () => {
    expect(await heldTokens(chain(null), mint, owner)).toBe(0);
  });
});
