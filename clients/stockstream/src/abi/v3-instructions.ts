import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { checkedSigned, checkedUnsigned, writeSigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, STOCKSTREAM_PROGRAM_KEY, type AddressInput } from "./transaction";
import { V3_BOOK_PAGES_PER_SIDE } from "./v3";

export type V3OrderSide = "bid" | "ask";
export type V3OrderTree = "fixed" | "oracle-pegged";
export type V3SelfTradeBehavior = "abort" | "cancel-provide" | "decrement-take";

export interface V3ExecutionAccounts {
  core: AddressInput;
  bookPages: readonly AddressInput[];
  seatShards: readonly AddressInput[];
  eventShards: readonly AddressInput[];
  authority: AddressInput;
  session?: AddressInput;
}

export interface V3OrderParams extends V3ExecutionAccounts {
  seatIndex: number;
  side: V3OrderSide;
  tree?: V3OrderTree;
  quantity: bigint | number;
  priceOrOffset: bigint | number;
  expiresAt?: bigint | number;
  pegLimit?: bigint | number;
  clientOrderId: bigint | number;
  actionNonce?: bigint | number;
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  reduceOnly?: boolean;
  selfTradeBehavior?: V3SelfTradeBehavior;
}

export interface V3FundingAccounts extends V3ExecutionAccounts { }
export interface V3OracleAccounts {
  core: AddressInput;
  eventShards: readonly AddressInput[];
  payer: AddressInput;
  pythProgram: AddressInput;
  storage: AddressInput;
  treasury: AddressInput;
  systemProgram: AddressInput;
  instructionsSysvar: AddressInput;
}
export interface V3CommitAccounts extends V3ExecutionAccounts {
  payer: AddressInput;
  magicContext: AddressInput;
  magicProgram: AddressInput;
}
export interface V3ShardCommitAccounts {
  shard: AddressInput;
  core: AddressInput;
  authority: AddressInput;
  payer: AddressInput;
  magicContext: AddressInput;
  magicProgram: AddressInput;
}
export interface V3UndelegationRecoveryAccounts {
  core: AddressInput;
  payer: AddressInput;
  request: AddressInput;
  record: AddressInput;
  metadata: AddressInput;
  state?: AddressInput;
  commitRecord?: AddressInput;
  reimbursement?: AddressInput;
}

const MAGICBLOCK_DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

function selfTradeBits(value: V3SelfTradeBehavior = "abort"): number {
  return value === "abort" ? 0 : value === "cancel-provide" ? 1 << 3 : value === "decrement-take" ? 2 << 3 : (() => { throw new RangeError("Invalid self-trade behavior"); })();
}

function v3ExecutionMetas(accounts: V3ExecutionAccounts): AccountMeta[] {
  if (accounts.bookPages.length !== 2 * V3_BOOK_PAGES_PER_SIDE
      || accounts.seatShards.length !== 4 || accounts.eventShards.length !== 4) {
    throw new RangeError("V3 execution requires 18 book pages, 4 seat shards and 4 event shards");
  }
  const metas = [accountMeta(accounts.core, false, true),
    ...accounts.bookPages.map((address) => accountMeta(address, false, true)),
    ...accounts.seatShards.map((address) => accountMeta(address, false, true)),
    ...accounts.eventShards.map((address) => accountMeta(address, false, true)),
    accountMeta(accounts.authority, true, false)];
  if (accounts.session) metas.push(accountMeta(accounts.session, false, true));
  return metas;
}

function orderData(opcode: number, params: V3OrderParams): Uint8Array {
  const data = new Uint8Array(opcode === OPCODE.replaceOrder ? 70 : 54);
  data[0] = opcode;
  const base = opcode === OPCODE.replaceOrder ? 17 : 1;
  if (opcode === OPCODE.replaceOrder) writeUnsigned(data, 1, checkedUnsigned((params as V3OrderParams & { oldOrderKey: bigint }).oldOrderKey, 128, "oldOrderKey"), 16);
  data[base] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[base + 1] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[base + 2] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0) | selfTradeBits(params.selfTradeBehavior);
  if (data[base] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, base + 3, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, base + 5, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, base + 13, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, base + 21, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, base + 29, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, base + 37, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, base + 45, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return data;
}

export function placeOrderV3(params: V3OrderParams): TransactionInstruction {
  return instruction(orderData(OPCODE.placeOrder, params), v3ExecutionMetas(params));
}

export function replaceOrderV3(params: V3OrderParams & { oldOrderKey: bigint }): TransactionInstruction {
  return instruction(orderData(OPCODE.replaceOrder, params), v3ExecutionMetas(params));
}

export function cancelOrderV3(accounts: V3ExecutionAccounts, seatIndex: number, orderKey: bigint, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(27); data[0] = OPCODE.cancelOrder;
  writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16);
  writeUnsigned(data, 19, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return instruction(data, v3ExecutionMetas(accounts));
}

export function cancelAllV3(accounts: V3ExecutionAccounts, seatIndex: number, maxCancellations: number, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(12); data[0] = OPCODE.cancelAll;
  writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations"));
  writeUnsigned(data, 4, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return instruction(data, v3ExecutionMetas(accounts));
}

export function updateFundingV3(accounts: V3FundingAccounts, accumulator: bigint, timestamp: bigint | number): TransactionInstruction {
  const metas = v3ExecutionMetas(accounts);
  metas.pop();
  const data = new Uint8Array(25); data[0] = OPCODE.updateFunding;
  writeSigned(data, 1, checkedSigned(accumulator, 128, "accumulator"), 16);
  writeUnsigned(data, 17, checkedUnsigned(timestamp, 64, "timestamp"), 8);
  return instruction(data, [...metas, accountMeta(accounts.authority, true, false)]);
}

export function consumeOracleUpdateV3(accounts: V3OracleAccounts, message: Uint8Array, ed25519InstructionIndex: number, signatureIndex: number): TransactionInstruction {
  if (accounts.eventShards.length !== 4) throw new RangeError("V3 oracle update requires four event shards");
  if (message.length < 102 || message.length > 512) throw new RangeError("Invalid signed Pyth message length");
  if (!Number.isInteger(ed25519InstructionIndex) || ed25519InstructionIndex < 0 || ed25519InstructionIndex > 0xffff) throw new RangeError("ed25519InstructionIndex must be a u16");
  if (!Number.isInteger(signatureIndex) || signatureIndex < 0 || signatureIndex > 0xff) throw new RangeError("signatureIndex must be a u8");
  const data = new Uint8Array(4 + message.length);
  data[0] = OPCODE.consumeOracleUpdate;
  new DataView(data.buffer).setUint16(1, ed25519InstructionIndex, true);
  data[3] = signatureIndex;
  data.set(message, 4);
  return instruction(data, [accountMeta(accounts.core, false, true),
    ...accounts.eventShards.map((shard) => accountMeta(shard, false, true)),
    accountMeta(accounts.payer, true, true), accountMeta(accounts.pythProgram, false, false),
    accountMeta(accounts.storage, false, false), accountMeta(accounts.treasury, false, true),
    accountMeta(accounts.systemProgram, false, false), accountMeta(accounts.instructionsSysvar, false, false)]);
}

function v3CommitMetas(accounts: V3CommitAccounts): AccountMeta[] {
  if (accounts.bookPages.length !== 2 * V3_BOOK_PAGES_PER_SIDE || accounts.seatShards.length !== 4 || accounts.eventShards.length !== 4) {
    throw new RangeError("V3 commit requires the complete execution bundle");
  }
  return [accountMeta(accounts.core, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true), accountMeta(accounts.magicContext, false, true),
    accountMeta(accounts.magicProgram, false, false),
    ...accounts.bookPages.map((address) => accountMeta(address, false, true)),
    ...accounts.seatShards.map((address) => accountMeta(address, false, true)),
    ...accounts.eventShards.map((address) => accountMeta(address, false, true))];
}

export function commitMarketV3(accounts: V3CommitAccounts, sequence: bigint | number, undelegate = false): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = undelegate ? OPCODE.commitAndUndelegate : OPCODE.commitMarket;
  writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, v3CommitMetas(accounts));
}

export function commitV3Shard(accounts: V3ShardCommitAccounts, sequence: bigint | number, undelegate = false): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = undelegate ? OPCODE.commitAndUndelegate : OPCODE.commitMarket;
  writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [accountMeta(accounts.shard, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true), accountMeta(accounts.magicContext, false, true),
    accountMeta(accounts.magicProgram, false, false), accountMeta(accounts.core, false, true)]);
}

export function requestV3Undelegation(accounts: V3UndelegationRecoveryAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(OPCODE.requestV3Undelegation), [
    accountMeta(accounts.payer, true, true), accountMeta(accounts.core, false, false),
    accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false), accountMeta(accounts.request, false, true),
    accountMeta(accounts.record, false, false), accountMeta(accounts.metadata, false, true),
    accountMeta(SystemProgram.programId, false, false), accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false)]);
}

export function rollbackV3Undelegation(accounts: V3UndelegationRecoveryAccounts): TransactionInstruction {
  if (!accounts.state || !accounts.commitRecord || !accounts.reimbursement) throw new RangeError("rollback requires state, commitRecord and reimbursement");
  return instruction(Uint8Array.of(OPCODE.rollbackV3Undelegation), [
    accountMeta(accounts.core, false, true), accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false),
    accountMeta(accounts.request, false, true), accountMeta(accounts.record, false, true),
    accountMeta(accounts.metadata, false, true), accountMeta(accounts.payer, false, true),
    accountMeta(accounts.state, false, true), accountMeta(accounts.commitRecord, false, true),
    accountMeta(accounts.reimbursement, false, true), accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false)]);
}
