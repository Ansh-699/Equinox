import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { verifySignature, type SignatureBytes } from "@solana/kit";
import { tradingKeyFromSignature, tradingKeySigner } from "./trading-key";

describe("trading key", () => {
  it("is deterministic in the wallet signature", async () => {
    const sig = new Uint8Array(64).fill(7);
    expect((await tradingKeyFromSignature(sig)).publicKey.toBase58()).toBe((await tradingKeyFromSignature(sig.slice())).publicKey.toBase58());
    expect((await tradingKeyFromSignature(new Uint8Array(64))).publicKey.equals((await tradingKeyFromSignature(sig)).publicKey)).toBe(false);
  });
  it("signs transactions and messages silently", async () => {
    const key = Keypair.generate();
    const signer = tradingKeySigner(key);
    const message = new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: key.publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: key.publicKey, lamports: 1 })] }).compileToV0Message();
    const signed = VersionedTransaction.deserialize(await signer.signTransaction(new VersionedTransaction(message).serialize()));
    expect(signed.signatures[0].some((b) => b !== 0)).toBe(true);
    const bytes = new TextEncoder().encode("hi");
    const signature = await signer.signMessage(bytes);
    const { createKeyPairFromPrivateKeyBytes } = await import("@solana/kit");
    const pair = await createKeyPairFromPrivateKeyBytes(key.secretKey.slice(0, 32));
    expect(await verifySignature(pair.publicKey, signature as SignatureBytes, bytes)).toBe(true);
  });
});
