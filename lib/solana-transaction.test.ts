import { describe, expect, it } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
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

  it("fits a 33-account custody instruction only through the market lookup table", () => {
    const payer = Keypair.generate().publicKey;
    const accounts = Array.from({ length: 33 }, () => Keypair.generate().publicKey);
    const instruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
      data: Buffer.alloc(11),
    });
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: accounts },
    });
    expect(encodeTransaction(payer.toBase58(), [instruction], payer.toBase58()).length).toBeGreaterThan(1232);
    const bytes = encodeTransaction(payer.toBase58(), [instruction], payer.toBase58(), [table]);
    const decoded = VersionedTransaction.deserialize(bytes);
    expect(bytes.length).toBeLessThan(1232);
    expect(decoded.message.addressTableLookups[0].accountKey.toBase58()).toBe(table.key.toBase58());
  });
});
