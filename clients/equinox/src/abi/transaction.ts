import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { EQUINOX_PROGRAM_ID } from "../constants";

export type AddressInput = PublicKey | string;
export const EQUINOX_PROGRAM_KEY = new PublicKey(EQUINOX_PROGRAM_ID);

export function publicKey(value: AddressInput): PublicKey {
  if (value instanceof PublicKey) return value;
  try { return new PublicKey(value); } catch { throw new RangeError("Invalid Solana public key"); }
}

export function accountMeta(address: AddressInput, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey: publicKey(address), isSigner, isWritable };
}

export function instruction(data: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: EQUINOX_PROGRAM_KEY, keys: accounts, data: Buffer.from(data) });
}
