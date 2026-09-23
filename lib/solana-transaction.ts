import { PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";

/** Compiles instructions into an unsigned v0 transaction ready for wallet signing.
 * V3 custody instructions carry 33 accounts and only fit through the market's lookup table. */
export function encodeTransaction(
  payer: string,
  instructions: readonly TransactionInstruction[],
  blockhash: string,
  lookupTables: readonly AddressLookupTableAccount[] = [],
): Uint8Array {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message([...lookupTables]);
  return new VersionedTransaction(message).serialize();
}
