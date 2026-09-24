import { TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { accountMeta, instruction, type AddressInput } from "./transaction";

export const CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET = 4;
export interface ConsumeOracleUpdateAccounts { market: AddressInput; payer: AddressInput; pythProgram: AddressInput; storage: AddressInput; treasury: AddressInput; systemProgram: AddressInput; instructionsSysvar: AddressInput; }

/** Builds the signed Pyth Lazer envelope consumed by the on-chain verifier. */
export function consumeOracleUpdate(accounts: ConsumeOracleUpdateAccounts, message: Uint8Array, ed25519InstructionIndex: number, signatureIndex: number): TransactionInstruction {
  if (message.length < 102 || message.length > 512) throw new RangeError("Invalid signed Pyth message length");
  if (!Number.isInteger(ed25519InstructionIndex) || ed25519InstructionIndex < 0 || ed25519InstructionIndex > 0xffff) throw new RangeError("ed25519InstructionIndex must be a u16");
  if (!Number.isInteger(signatureIndex) || signatureIndex < 0 || signatureIndex > 0xff) throw new RangeError("signatureIndex must be a u8");
  const data = new Uint8Array(CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET + message.length); data[0] = OPCODE.consumeOracleUpdate;
  new DataView(data.buffer).setUint16(1, ed25519InstructionIndex, true); data[3] = signatureIndex; data.set(message, CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.payer, true, true), accountMeta(accounts.pythProgram, false, false), accountMeta(accounts.storage, false, false), accountMeta(accounts.treasury, false, true), accountMeta(accounts.systemProgram, false, false), accountMeta(accounts.instructionsSysvar, false, false)]);
}
