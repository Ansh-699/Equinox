import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";

/** Compiles instructions into an unsigned v0 transaction ready for wallet signing. */
export function encodeTransaction(payer: string, instructions: readonly TransactionInstruction[], blockhash: string): Uint8Array {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}
