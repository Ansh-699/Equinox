import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { encodeTransaction } from "./solana-transaction";

describe("encodeTransaction", () => {
  it("compiles a v0 message carrying the payer, blockhash and instructions", () => {
    const payer = PublicKey.default;
    const programId = SystemProgram.programId;
    const blockhash = payer.toBase58();
    const instruction = new TransactionInstruction({ programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([7]) });

    const bytes = encodeTransaction(payer.toBase58(), [instruction], blockhash);
    const decoded = VersionedTransaction.deserialize(bytes);

    expect(decoded.message.recentBlockhash).toBe(blockhash);
    expect(decoded.message.staticAccountKeys[0].toBase58()).toBe(payer.toBase58());
    expect(decoded.message.compiledInstructions).toHaveLength(1);
    expect(Array.from(decoded.message.compiledInstructions[0].data)).toEqual([7]);
  });
});
