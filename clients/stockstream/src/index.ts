import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { STOCKSTREAM_ACCOUNT_SIZE, STOCKSTREAM_INSTRUCTION, STOCKSTREAM_PROGRAM_ID, STOCKSTREAM_TRADING_SESSION_SIZE } from "./constants";
import { deriveBookPageV3, deriveEventShardV3, deriveMarketCoreV3, deriveSeatShardV3, V3_BOOK_PAGES_PER_SIDE } from "./abi/v3";

export const STOCKSTREAM_PROGRAM_KEY = new PublicKey(STOCKSTREAM_PROGRAM_ID);
export type AddressInput = PublicKey | string;
export type Side = "bid" | "ask";
export type OrderTree = "fixed" | "oracle-pegged";

export interface InstructionAccounts {
  market: AddressInput;
  authority: AddressInput;
}

export interface PlaceOrderParams extends InstructionAccounts {
  /** Per-market/per-seat PDA: ["settlement", market, seat_index_le]. */
  settlementScratch: AddressInput;
  seatIndex: number;
  side: Side;
  tree?: OrderTree;
  quantity: bigint | number;
  priceOrOffset: bigint | number;
  expiresAt?: bigint | number;
  pegLimit?: bigint | number;
  clientOrderId: bigint | number;
  /** Required for scoped-session actions. Main-wallet actions must use zero. */
  actionNonce?: bigint | number;
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  reduceOnly?: boolean;
  /** Program-owned TradingSession account when authority is a scoped signer. */
  session?: AddressInput;
}

export interface InstructionFixture {
  name: string;
  data: Uint8Array;
}
export interface SessionAuthorizedAccounts extends InstructionAccounts { session?: AddressInput; }

export interface VaultAccounts { market: AddressInput; authority: AddressInput; mint: AddressInput; tokenProgram: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; }
export interface CustodyAccounts extends VaultAccounts { seatIndex: number; sourceOrDestination: AddressInput; }
export interface InsuranceTransferAccounts { market: AddressInput; authority: AddressInput; }
/** `authority` is the market authority for `withdrawProtocolFees`, the market's `emergencyAuthority` for `withdrawInsuranceFunds`. */
export interface LedgerWithdrawalAccounts { market: AddressInput; authority: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; destination: AddressInput; mint: AddressInput; tokenProgram: AddressInput; }
/** `authority` must be the market's `emergencyAuthority`. */
export interface BadDebtAccounts { market: AddressInput; authority: AddressInput; }
export interface ReconcileAccounts { market: AddressInput; vault: AddressInput; mint: AddressInput; tokenProgram: AddressInput; }
export interface DelegationAccounts { market: AddressInput; authority: AddressInput; instrument: AddressInput; payer: AddressInput; clusterAccounts?: AddressInput[]; }
export interface CommitAccounts { market: AddressInput; authority: AddressInput; payer: AddressInput; clusterAccounts?: AddressInput[]; }
export interface ClusterMemberAccounts { market: AddressInput; authority: AddressInput; member: AddressInput; payer: AddressInput; }

/** MagicBlock Delegation Program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. */
export const MAGICBLOCK_DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
/** MagicBlock Magic Program: `Magic11111111111111111111111111111111111111`. */
export const MAGICBLOCK_MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
/** MagicBlock Magic Context account: `MagicContext1111111111111111111111111111111`. */
export const MAGICBLOCK_MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export interface RegistryAccounts { exchange: AddressInput; authority: AddressInput; }
export interface InstrumentAccounts { exchange: AddressInput; instrument: AddressInput; authority: AddressInput; }
export interface PerpMarketAccounts { instrument: AddressInput; market: AddressInput; authority: AddressInput; }
/** Account tuple for opcode 46. `parent` is an instrument for `core`, and a V3 core otherwise. */
export interface V3CreationAccounts { parent: AddressInput; target: AddressInput; payer: AddressInput; }
export type V3AccountKind = "core" | "book-page" | "seat-shard" | "event-shard";
export interface V3InitializationAccounts { exchange: AddressInput; instrument: AddressInput; core: AddressInput; authority: AddressInput; }
export interface V3DelegationAccounts extends V3CreationAccounts { authority: AddressInput; }
export interface V3SeatAccounts { core: AddressInput; seatShards: readonly AddressInput[]; eventShards: readonly AddressInput[]; trader: AddressInput; }
export interface V3ExecutionAccounts {
  core: AddressInput;
  bookPages: readonly AddressInput[];
  seatShards: readonly AddressInput[];
  eventShards: readonly AddressInput[];
  authority: AddressInput;
  session?: AddressInput;
}
export interface V3CommitAccounts extends V3ExecutionAccounts {
  payer: AddressInput;
  magicContext: AddressInput;
  magicProgram: AddressInput;
}
/** One-shard commit ABI used when MagicBlock rejects a full 27-account intent. */
export interface V3ShardCommitAccounts {
  shard: AddressInput;
  core: AddressInput;
  authority: AddressInput;
  payer: AddressInput;
  magicContext: AddressInput;
  magicProgram: AddressInput;
}

function publicKey(value: AddressInput): PublicKey {
  if (value instanceof PublicKey) return value;
  try { return new PublicKey(value); } catch { throw new RangeError("Invalid Solana public key"); }
}

function checkedUnsigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : -1n;
  if (result < 0n || result >= 1n << BigInt(bits)) throw new RangeError(`${name} is outside u${bits}`);
  return result;
}

function checkedSigned(value: bigint | number, bits: number, name: string): bigint {
  const result = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n;
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (result < min || result > max) throw new RangeError(`${name} is outside i${bits}`);
  return result;
}

function writeUnsigned(data: Uint8Array, offset: number, value: bigint, bytes: number) {
  let current = value;
  for (let i = 0; i < bytes; i += 1) { data[offset + i] = Number(current & 0xffn); current >>= 8n; }
}

function writeSigned(data: Uint8Array, offset: number, value: bigint, bytes: number) {
  writeUnsigned(data, offset, value < 0n ? (1n << BigInt(bytes * 8)) + value : value, bytes);
}

function accountMeta(address: AddressInput, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey: publicKey(address), isSigner, isWritable };
}

function instruction(data: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: STOCKSTREAM_PROGRAM_KEY, keys: accounts, data: Buffer.from(data) });
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

export function initializeMarket(accounts: InstructionAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeMarket), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false),
  ]);
}

export function createTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.createTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function initializeSettlementScratch(accounts: InstructionAccounts & { settlementScratch: AddressInput }, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.initializeSettlementScratch; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.settlementScratch, false, true)]);
}

export function closeTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction {
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.closeTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function placeOrder(params: PlaceOrderParams): TransactionInstruction {
  const data = new Uint8Array(54);
  data[0] = STOCKSTREAM_INSTRUCTION.placeOrder;
  data[1] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[2] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[3] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[1] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 4, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 6, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 14, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 22, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 30, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, 46, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)];
  if (params.session) accounts.push(accountMeta(params.session, false, true));
  return instruction(data, accounts);
}

/** Builds the same PlaceOrder wire bytes against the canonical V3 execution
 * bundle. The V3 account order is core, 18 pages, 4 seat shards, 4 event
 * shards, signer, optional session; no V2 settlement scratch is accepted. */
export function placeOrderV3(params: Omit<PlaceOrderParams, "market" | "authority" | "settlementScratch"> & V3ExecutionAccounts): TransactionInstruction {
  const data = new Uint8Array(54);
  data[0] = STOCKSTREAM_INSTRUCTION.placeOrder;
  data[1] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[2] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[3] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[1] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 4, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 6, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 14, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 22, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 30, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, 46, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return instruction(data, v3ExecutionMetas(params));
}

/**
 * Atomically cancels `oldOrderKey` and places a new order in its place. The
 * new order always receives a fresh sequence number, so a replacement
 * always loses book time priority. If the new order fails validation
 * (margin, session notional, ...), the whole instruction reverts, leaving
 * the original order, its reserve, and the session's nonce/notional
 * untouched -- see `handlers::replace_order` in the Rust program.
 */
export function replaceOrder(params: PlaceOrderParams & { oldOrderKey: bigint }): TransactionInstruction {
  const data = new Uint8Array(70);
  data[0] = STOCKSTREAM_INSTRUCTION.replaceOrder;
  writeUnsigned(data, 1, checkedUnsigned(params.oldOrderKey, 128, "oldOrderKey"), 16);
  data[17] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[18] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[19] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[17] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 20, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 22, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 30, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 46, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 54, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  writeUnsigned(data, 62, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)];
  if (params.session) accounts.push(accountMeta(params.session, false, true));
  return instruction(data, accounts);
}

export function replaceOrderV3(params: Omit<PlaceOrderParams, "market" | "authority" | "settlementScratch"> & V3ExecutionAccounts & { oldOrderKey: bigint }): TransactionInstruction {
  const data = new Uint8Array(70); data[0] = STOCKSTREAM_INSTRUCTION.replaceOrder;
  writeUnsigned(data, 1, checkedUnsigned(params.oldOrderKey, 128, "oldOrderKey"), 16);
  data[17] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255;
  data[18] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[19] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0);
  if (data[17] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 20, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 22, checkedUnsigned(params.quantity, 64, "quantity"), 8);
  writeSigned(data, 30, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8);
  writeUnsigned(data, 38, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8);
  writeSigned(data, 46, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8);
  writeUnsigned(data, 54, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0;
  if (actionNonce !== 0) throw new RangeError("V3 replacement currently requires a main-wallet action");
  writeUnsigned(data, 62, 0n, 8);
  return instruction(data, v3ExecutionMetas(params));
}

export function cancelOrder(accounts: SessionAuthorizedAccounts, seatIndex: number, orderKey: bigint, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(27); data[0] = STOCKSTREAM_INSTRUCTION.cancelOrder; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16); writeUnsigned(data, 19, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas);
}

export function cancelOrderV3(accounts: V3ExecutionAccounts, seatIndex: number, orderKey: bigint, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(27); data[0] = STOCKSTREAM_INSTRUCTION.cancelOrder;
  writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16);
  writeUnsigned(data, 19, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return instruction(data, v3ExecutionMetas(accounts));
}

export function cancelAll(accounts: SessionAuthorizedAccounts, seatIndex: number, maxCancellations: number, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(12); data[0] = STOCKSTREAM_INSTRUCTION.cancelAll; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations")); writeUnsigned(data, 4, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas);
}

export function cancelAllV3(accounts: V3ExecutionAccounts, seatIndex: number, maxCancellations: number, actionNonce: bigint | number = 0): TransactionInstruction {
  if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero");
  const data = new Uint8Array(12); data[0] = STOCKSTREAM_INSTRUCTION.cancelAll;
  writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2);
  data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations"));
  writeUnsigned(data, 4, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  return instruction(data, v3ExecutionMetas(accounts));
}

function v3CommitMetas(accounts: V3CommitAccounts): AccountMeta[] {
  if (accounts.bookPages.length !== 2 * V3_BOOK_PAGES_PER_SIDE || accounts.seatShards.length !== 4 || accounts.eventShards.length !== 4) {
    throw new RangeError("V3 commit requires the complete execution bundle");
  }
  return [
    accountMeta(accounts.core, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true), accountMeta(accounts.magicContext, false, true),
    accountMeta(accounts.magicProgram, false, false),
    ...accounts.bookPages.map((address) => accountMeta(address, false, true)),
    ...accounts.seatShards.map((address) => accountMeta(address, false, true)),
    ...accounts.eventShards.map((address) => accountMeta(address, false, true)),
  ];
}

export function commitMarketV3(accounts: V3CommitAccounts, sequence: bigint | number, undelegate = false): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = undelegate ? STOCKSTREAM_INSTRUCTION.commitAndUndelegate : STOCKSTREAM_INSTRUCTION.commitMarket;
  writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, v3CommitMetas(accounts));
}

export function commitV3Shard(accounts: V3ShardCommitAccounts, sequence: bigint | number, undelegate = false): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = undelegate ? STOCKSTREAM_INSTRUCTION.commitAndUndelegate : STOCKSTREAM_INSTRUCTION.commitMarket;
  writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [
    accountMeta(accounts.shard, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true), accountMeta(accounts.magicContext, false, true),
    accountMeta(accounts.magicProgram, false, false), accountMeta(accounts.core, false, true),
  ]);
}

export function updateFunding(accounts: InstructionAccounts, accumulator: bigint, timestamp: bigint | number): TransactionInstruction {
  const data = new Uint8Array(25); data[0] = STOCKSTREAM_INSTRUCTION.updateFunding; writeSigned(data, 1, checkedSigned(accumulator, 128, "accumulator"), 16); writeUnsigned(data, 17, checkedUnsigned(timestamp, 64, "timestamp"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function liquidate(accounts: InstructionAccounts, seatIndex: number, maxQuantity: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = STOCKSTREAM_INSTRUCTION.liquidate; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(maxQuantity, 64, "maxQuantity"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function initializeVault(accounts: VaultAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeVault), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.tokenProgram, false, false), accountMeta(accounts.vault, false, true), accountMeta(accounts.vaultAuthority, false, false),
  ]);
}

function amountInstruction(discriminator: number, accounts: CustodyAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(accounts.seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(amount, 64, "amount"), 8);
  // 6 accounts, not 7: the seat lives inside the market account itself, so a
  // separate "seat slot" account is never read by the deposit handler.
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.vault, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
export function depositCollateral(accounts: CustodyAccounts, amount: bigint | number) { return amountInstruction(STOCKSTREAM_INSTRUCTION.depositCollateral, accounts, amount); }
export function withdrawCollateral(accounts: CustodyAccounts, amount: bigint | number) {
  const result = amountInstruction(STOCKSTREAM_INSTRUCTION.withdrawCollateral, accounts, amount);
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from('vault-authority'), new PublicKey(accounts.market).toBuffer()], new PublicKey(STOCKSTREAM_PROGRAM_ID))[0];
  result.keys = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.vault, false, true), accountMeta(vaultAuthority, false, false), accountMeta(accounts.tokenProgram, false, false)];
  return result;
}

/** Internal ledger reassignment (protocol fees -> insurance fund); no token CPI. Market-authority-signed. */
export function transferToInsuranceFund(accounts: InsuranceTransferAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.transferToInsuranceFund; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

function ledgerWithdrawal(discriminator: number, accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [
    accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false),
    accountMeta(accounts.vault, false, true), accountMeta(accounts.vaultAuthority, false, false),
    accountMeta(accounts.destination, false, true), accountMeta(accounts.mint, false, false),
    accountMeta(accounts.tokenProgram, false, false),
  ]);
}
/** Pays `amount` out of the protocol fee ledger via a real vault-authority-signed SPL transfer. Market-authority-signed. */
export function withdrawProtocolFees(accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction {
  return ledgerWithdrawal(STOCKSTREAM_INSTRUCTION.withdrawProtocolFees, accounts, amount);
}
/** Pays `amount` out of the insurance fund ledger via a real vault-authority-signed SPL transfer. Emergency-authority-signed. */
export function withdrawInsuranceFunds(accounts: LedgerWithdrawalAccounts, amount: bigint | number): TransactionInstruction {
  return ledgerWithdrawal(STOCKSTREAM_INSTRUCTION.withdrawInsuranceFunds, accounts, amount);
}

/** Formally recognizes `amount` of a bankrupt seat's negative equity as unrecoverable bad debt. Emergency-authority-signed. */
export function recordBadDebt(accounts: BadDebtAccounts, seatIndex: number, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(11); data[0] = STOCKSTREAM_INSTRUCTION.recordBadDebt; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}
/** Pays `amount` of recognized bad debt down from the insurance fund ledger. Emergency-authority-signed. */
export function resolveBadDebt(accounts: BadDebtAccounts, amount: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.resolveBadDebt; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}
/** Permissionless: recomputes the vault's actual balance against trader collateral + fee/insurance ledgers - recognized bad debt, and records the result. */
export function reconcileVault(accounts: ReconcileAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.reconcileVault), [
    accountMeta(accounts.market, false, true), accountMeta(accounts.vault, false, false),
    accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false),
  ]);
}

/** Mirrors `programs/stockstream/src/instruction.rs::exchange_config_field`
 * exactly -- one bit per `UpdateExchangeConfig` field. */
export const EXCHANGE_CONFIG_FIELD = {
  pauseAuthority: 1 << 0,
  emergencyAuthority: 1 << 1,
  keeperAuthority: 1 << 2,
  makerFeeBps: 1 << 3,
  takerFeeBps: 1 << 4,
  liquidationFeeBps: 1 << 5,
  defaultInitialMarginBps: 1 << 6,
  defaultMaintenanceMarginBps: 1 << 7,
  defaultMaximumLeverage: 1 << 8,
  collateralMint: 1 << 9,
  oracleProgram: 1 << 10,
  insuranceTargetBalance: 1 << 11,
  protocolStatus: 1 << 12,
} as const;

export interface UpdateExchangeConfigFields {
  pauseAuthority?: AddressInput;
  emergencyAuthority?: AddressInput;
  keeperAuthority?: AddressInput;
  makerFeeBps?: number;
  takerFeeBps?: number;
  liquidationFeeBps?: number;
  defaultInitialMarginBps?: number;
  defaultMaintenanceMarginBps?: number;
  defaultMaximumLeverage?: number;
  collateralMint?: AddressInput;
  oracleProgram?: AddressInput;
  insuranceTargetBalance?: bigint | number;
  protocolStatus?: number;
}

/**
 * Only the fields present as keys of `fields` are applied on-chain (the
 * field mask is derived from which keys are set, not their value) --
 * every other field is still present on the wire, zeroed, exactly
 * matching `programs/stockstream/src/instruction.rs`'s fixed 196-byte
 * `UpdateExchangeConfig` layout. `expectedConfigSequence` must equal the
 * exchange account's current `config_sequence` (read it from the account
 * first) or the instruction is rejected as a stale concurrent update.
 */
export function updateExchangeConfig(
  accounts: RegistryAccounts,
  fields: UpdateExchangeConfigFields,
  expectedConfigSequence: bigint | number,
): TransactionInstruction {
  let fieldMask = 0;
  const data = new Uint8Array(196);
  data[0] = STOCKSTREAM_INSTRUCTION.updateExchangeConfig;
  const writePubkeyField = (offset: number, bit: number, value: AddressInput | undefined) => {
    if (value === undefined) return;
    fieldMask |= bit;
    data.set(publicKey(value).toBytes(), offset);
  };
  const writeU16Field = (offset: number, bit: number, value: number | undefined) => {
    if (value === undefined) return;
    fieldMask |= bit;
    writeUnsigned(data, offset, checkedUnsigned(value, 16, "value"), 2);
  };
  writePubkeyField(5, EXCHANGE_CONFIG_FIELD.pauseAuthority, fields.pauseAuthority);
  writePubkeyField(37, EXCHANGE_CONFIG_FIELD.emergencyAuthority, fields.emergencyAuthority);
  writePubkeyField(69, EXCHANGE_CONFIG_FIELD.keeperAuthority, fields.keeperAuthority);
  writeU16Field(101, EXCHANGE_CONFIG_FIELD.makerFeeBps, fields.makerFeeBps);
  writeU16Field(103, EXCHANGE_CONFIG_FIELD.takerFeeBps, fields.takerFeeBps);
  writeU16Field(105, EXCHANGE_CONFIG_FIELD.liquidationFeeBps, fields.liquidationFeeBps);
  writeU16Field(107, EXCHANGE_CONFIG_FIELD.defaultInitialMarginBps, fields.defaultInitialMarginBps);
  writeU16Field(109, EXCHANGE_CONFIG_FIELD.defaultMaintenanceMarginBps, fields.defaultMaintenanceMarginBps);
  if (fields.defaultMaximumLeverage !== undefined) {
    fieldMask |= EXCHANGE_CONFIG_FIELD.defaultMaximumLeverage;
    writeUnsigned(data, 111, checkedUnsigned(fields.defaultMaximumLeverage, 32, "defaultMaximumLeverage"), 4);
  }
  writePubkeyField(115, EXCHANGE_CONFIG_FIELD.collateralMint, fields.collateralMint);
  writePubkeyField(147, EXCHANGE_CONFIG_FIELD.oracleProgram, fields.oracleProgram);
  if (fields.insuranceTargetBalance !== undefined) {
    fieldMask |= EXCHANGE_CONFIG_FIELD.insuranceTargetBalance;
    writeUnsigned(data, 179, checkedUnsigned(fields.insuranceTargetBalance, 64, "insuranceTargetBalance"), 8);
  }
  if (fields.protocolStatus !== undefined) {
    fieldMask |= EXCHANGE_CONFIG_FIELD.protocolStatus;
    data[187] = fields.protocolStatus;
  }
  writeUnsigned(data, 1, BigInt(fieldMask), 4);
  writeUnsigned(data, 188, checkedUnsigned(expectedConfigSequence, 64, "expectedConfigSequence"), 8);
  return instruction(data, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]);
}

// ---------------------------------------------------------------------
// Priority 7: the complete, versioned, binary StockStream event ABI
// (`programs/stockstream/src/events.rs`). Every event is one real
// `sol_log_data` syscall call, surfacing in `meta.logMessages` as a single
// `Program data: <base64>` line carrying exactly `EVENT_SIZE` (100) bytes:
// a fixed header (discriminator, ABI version, sequence, market, timestamp)
// followed by a fixed 48-byte payload whose fields depend on the
// discriminator. This replaced the earlier Priority-4 custody-only
// `SS:<Kind> ...` text format (`Program log:` lines via `pinocchio_log`)
// with this single ABI covering every event category.
// ---------------------------------------------------------------------

export const EVENT_ABI_VERSION = 1;
export const EVENT_HEADER_SIZE = 52;
export const EVENT_PAYLOAD_SIZE = 48;
export const EVENT_SIZE = EVENT_HEADER_SIZE + EVENT_PAYLOAD_SIZE;
/** Sentinel `seatIndex` meaning "this event is market-level, not one trader seat's" -- mirrors `events::NO_SEAT`. */
export const NO_SEAT = 0xffff;

export const EVENT_KIND_NAMES: Record<number, string> = {
  100: "ExchangeInitialized", 101: "ExchangeConfigUpdated", 102: "StockInstrumentRegistered",
  103: "StockInstrumentUpdated", 104: "StockInstrumentSuspended", 105: "PerpMarketCreated",
  106: "MarketRiskUpdated", 107: "MarketPaused", 108: "MarketResumed", 109: "MarketCloseOnly",
  110: "CorporateActionEntered", 111: "CorporateActionResolved", 112: "MarketClosed",
  200: "TraderSeatCreated", 201: "TraderSeatClosed", 202: "OrderPlaced", 203: "OrderPartiallyFilled",
  204: "OrderFilled", 205: "OrderCancelled", 206: "CancelAllProgress", 207: "OrderReplaced",
  208: "OrderExpired", 209: "InvalidOrderRemoved", 210: "SelfTradePrevented",
  300: "PositionChanged", 301: "MarginChanged", 302: "FundingAccumulatorUpdated", 303: "FundingSettled",
  304: "LiquidationStarted", 305: "PositionLiquidated", 306: "BankruptcyRecorded", 307: "InsuranceApplied",
  400: "VaultInitialized", 401: "CollateralDeposited", 402: "CollateralWithdrawn", 403: "ProtocolFeesChanged",
  404: "InsuranceFundChanged", 405: "BadDebtRecorded", 406: "BadDebtResolved", 407: "VaultSurplusDetected",
  408: "VaultDeficitDetected", 409: "VaultReconciled",
  500: "OracleUpdated", 501: "OracleRejected", 502: "MarketSessionChanged", 503: "TradingStatusChanged",
  504: "OracleStale", 505: "OracleRecovered",
  600: "DelegationRequested", 601: "MarketDelegated", 602: "CommitRequested", 603: "CommitSequenceChanged",
  604: "UndelegationRequested", 605: "RestorationPending", 606: "MarketRestored", 607: "DelegationErrorState",
  700: "TradingSessionAuthorized", 701: "TradingSessionLimitsUpdated", 702: "TradingSessionActionConsumed",
  703: "TradingSessionRevoked", 704: "TradingSessionClosed",
};

export interface StockStreamEvent {
  discriminator: number;
  /** Human-readable name for a known discriminator, or `Unknown(<n>)` for
   * a future/unrecognized one -- the raw discriminator and payload are
   * still returned so an indexer can preserve the record rather than
   * dropping it. */
  kind: string;
  abiVersion: number;
  sequence: bigint;
  /** 64-character lowercase hex market pubkey. */
  market: string;
  timestamp: bigint;
  /** The raw 48-byte payload; use the `decode*Payload` helpers below for
   * the shape matching this event's `kind`. */
  payload: Uint8Array;
}

/**
 * Decodes one StockStream event out of a transaction log line. Returns
 * `null` for a line that isn't a `Program data:` record, that fails to
 * base64-decode, or whose decoded length doesn't exactly match `EVENT_SIZE`
 * (a truncated or foreign record) -- never for an unrecognized
 * discriminator, since a future ABI version's new event kinds should still
 * be preserved (`kind` becomes `Unknown(<n>)`), not silently dropped.
 */
export function decodeStockStreamEvent(logLine: string): StockStreamEvent | null {
  const prefix = "Program data: ";
  if (!logLine.startsWith(prefix)) return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(logLine.slice(prefix.length).trim(), "base64"); } catch { return null; }
  if (bytes.length !== EVENT_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const discriminator = view.getUint16(0, true);
  return {
    discriminator,
    kind: EVENT_KIND_NAMES[discriminator] ?? `Unknown(${discriminator})`,
    abiVersion: bytes[2],
    sequence: view.getBigUint64(4, true),
    market: Buffer.from(bytes.subarray(12, 44)).toString("hex"),
    timestamp: view.getBigUint64(44, true),
    payload: bytes.subarray(EVENT_HEADER_SIZE, EVENT_SIZE),
  };
}

function payloadView(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}
/** `events::payload_seat`. */
export function decodeSeatPayload(payload: Uint8Array) {
  return { seatIndex: payloadView(payload).getUint16(0, true) };
}
/** `events::payload_seat_amount`. */
export function decodeSeatAmountPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return { seatIndex: view.getUint16(0, true), amount: view.getBigUint64(2, true), balance: view.getBigUint64(10, true) };
}
/** `events::payload_order`. */
export function decodeOrderPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return {
    seatIndex: view.getUint16(0, true),
    orderKey: (() => { let v = 0n; for (let i = 15; i >= 0; i -= 1) v = (v << 8n) | BigInt(payload[2 + i]); return v; })(),
    side: payload[18],
    price: view.getBigInt64(19, true),
    quantity: view.getBigUint64(27, true),
  };
}
/** `events::payload_fill`. */
export function decodeFillPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return {
    makerSeat: view.getUint32(0, true), takerSeat: view.getUint32(4, true),
    price: view.getBigInt64(8, true), quantity: view.getBigUint64(16, true), fillSequence: view.getBigUint64(24, true),
  };
}
function readI128(payload: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(payload[offset + i]);
  const signBit = 1n << 127n;
  return value >= signBit ? value - (signBit << 1n) : value;
}
/** `events::payload_position`. */
export function decodePositionPayload(payload: Uint8Array) {
  return { seatIndex: payloadView(payload).getUint16(0, true), basePosition: readI128(payload, 2), quoteEntryValue: readI128(payload, 18) };
}
/** `events::payload_funding`. */
export function decodeFundingPayload(payload: Uint8Array) {
  return { seatIndex: payloadView(payload).getUint16(0, true), accumulator: readI128(payload, 2), payment: readI128(payload, 18) };
}
/** `events::payload_liquidation`. */
export function decodeLiquidationPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return { seatIndex: view.getUint16(0, true), quantity: view.getBigUint64(2, true), price: view.getBigInt64(10, true) };
}
/** `events::payload_oracle`. */
export function decodeOraclePayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return { price: view.getBigInt64(0, true), exponent: view.getInt16(8, true), confidence: view.getBigInt64(10, true), session: view.getInt16(18, true) };
}
/** `events::payload_delegation`. */
export function decodeDelegationPayload(payload: Uint8Array) {
  return { validator: Buffer.from(payload.subarray(0, 32)).toString("hex"), sequence: payloadView(payload).getBigUint64(32, true) };
}
/** `events::payload_session`. */
export function decodeSessionPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return { seatIndex: view.getUint16(0, true), sessionSigner: Buffer.from(payload.subarray(2, 34)).toString("hex"), nonce: view.getBigUint64(34, true) };
}
/** `events::payload_registry`. */
export function decodeRegistryPayload(payload: Uint8Array) {
  return { instrumentId: Buffer.from(payload.subarray(0, 32)).toString("hex") };
}
/** `events::payload_reconciliation`. */
export function decodeReconciliationPayload(payload: Uint8Array) {
  const view = payloadView(payload);
  return { actual: view.getBigUint64(0, true), expected: view.getBigUint64(8, true), status: payload[16] };
}

/**
 * The signed Pyth message is embedded at byte offset 4 of this
 * instruction's own data (after the tag + `ed25519_instruction_index` +
 * `signature_index`); the Ed25519 precompile instruction the keeper places
 * before this one must reference that exact offset. `ed25519InstructionIndex`
 * and `signatureIndex` are not assumed by the program -- it independently
 * inspects the Instructions sysvar to confirm they name a real, preceding
 * Ed25519-program instruction before trusting them (and before the CPI into
 * Pyth's own `verify_message`, which repeats the check authoritatively).
 * See `handlers::consume_oracle_update` in the Rust program.
 */
export const CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET = 4;

export function consumeOracleUpdate(
  accounts: { market: AddressInput; payer: AddressInput; pythProgram: AddressInput; storage: AddressInput; treasury: AddressInput; systemProgram: AddressInput; instructionsSysvar: AddressInput },
  message: Uint8Array,
  ed25519InstructionIndex: number,
  signatureIndex: number,
): TransactionInstruction {
  if (message.length < 102 || message.length > 512) throw new RangeError('Invalid signed Pyth message length');
  if (!Number.isInteger(ed25519InstructionIndex) || ed25519InstructionIndex < 0 || ed25519InstructionIndex > 0xffff) throw new RangeError('ed25519InstructionIndex must be a u16');
  if (!Number.isInteger(signatureIndex) || signatureIndex < 0 || signatureIndex > 0xff) throw new RangeError('signatureIndex must be a u8');
  const data = new Uint8Array(CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET + message.length);
  data[0] = STOCKSTREAM_INSTRUCTION.consumeOracleUpdate;
  new DataView(data.buffer).setUint16(1, ed25519InstructionIndex, true);
  data[3] = signatureIndex;
  data.set(message, CONSUME_ORACLE_UPDATE_MESSAGE_OFFSET);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.payer, true, true),
    accountMeta(accounts.pythProgram, false, false), accountMeta(accounts.storage, false, false),
    accountMeta(accounts.treasury, false, true), accountMeta(accounts.systemProgram, false, false),
    accountMeta(accounts.instructionsSysvar, false, false)]);
}
/**
 * Real onchain MagicBlock `DelegateMarket`. Account order and the delegation
 * program/PDA derivations mirror `programs/stockstream/src/magicblock.rs`
 * exactly (which is itself verified against the delegation program's own
 * `magicblock-delegation-program-api` crate and source) -- this is not an
 * independent encoding, it must match the Rust side byte-for-byte.
 */
export function delegateMarket(accounts: DelegationAccounts, validator: AddressInput): TransactionInstruction {
  const market = publicKey(accounts.market);
  const validatorKey = publicKey(validator);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), market.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), market.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(33); data[0] = STOCKSTREAM_INSTRUCTION.delegateMarket; data.set(validatorKey.toBytes(), 1);
  return instruction(data, [
    accountMeta(market, false, true),
    accountMeta(accounts.authority, true, false),
    accountMeta(accounts.instrument, false, false),
    accountMeta(accounts.payer, true, true),
    accountMeta(buffer, false, true),
    accountMeta(delegationRecord, false, true),
    accountMeta(delegationMetadata, false, true),
    accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false),
    accountMeta(SystemProgram.programId, false, false),
    accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false),
    // Trailing cluster accounts are boundary-gated (scratch must be Empty),
    // not delegated here -- each member is delegated separately by
    // `delegateClusterMember`, batchable as post-instructions in the same L1
    // transaction.
    ...(accounts.clusterAccounts ?? []).map((a) => accountMeta(a, false, true)),
  ]);
}
/**
 * One delegated hot-cluster member: a settlement-scratch PDA (`Empty`) or a
 * `TradingSession` PDA, delegated to the market's validator by the same
 * Delegation-Program `Delegate` CPI the market itself uses, with its own
 * buffer/record/metadata PDAs derived from the member's address. Account
 * order mirrors `programs/stockstream/src/magicblock.rs::delegate_cluster_member`.
 */
export function delegateClusterMember(accounts: ClusterMemberAccounts, validator: AddressInput): TransactionInstruction {
  const market = publicKey(accounts.market);
  const member = publicKey(accounts.member);
  const validatorKey = publicKey(validator);
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), member.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [delegationRecord] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), member.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [delegationMetadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), member.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(33); data[0] = STOCKSTREAM_INSTRUCTION.delegateClusterMember; data.set(validatorKey.toBytes(), 1);
  return instruction(data, [
    accountMeta(market, false, false),
    accountMeta(accounts.authority, true, false),
    accountMeta(member, false, true),
    accountMeta(buffer, false, true),
    accountMeta(delegationRecord, false, true),
    accountMeta(delegationMetadata, false, true),
    accountMeta(accounts.payer, true, true),
    accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false),
    accountMeta(SystemProgram.programId, false, false),
    accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false),
  ]);
}
/** A member's own delegate-buffer / record / metadata PDAs (client-side derivation mirror). */
export function deriveClusterMemberPdas(member: AddressInput): { buffer: PublicKey; delegationRecord: PublicKey; delegationMetadata: PublicKey } {
  const memberKey = publicKey(member);
  return {
    buffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), memberKey.toBuffer()], STOCKSTREAM_PROGRAM_KEY)[0],
    delegationRecord: PublicKey.findProgramAddressSync([Buffer.from("delegation"), memberKey.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), memberKey.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID)[0],
  };
}
function commitInstruction(discriminator: number, accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [
    accountMeta(accounts.market, false, true),
    accountMeta(accounts.authority, true, false),
    accountMeta(accounts.payer, true, true),
    accountMeta(MAGICBLOCK_MAGIC_CONTEXT_ID, false, true),
    accountMeta(MAGICBLOCK_MAGIC_PROGRAM_ID, false, false),
    ...(accounts.clusterAccounts ?? []).map((a) => accountMeta(a, false, true)),
  ]);
}
export function commitMarket(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(STOCKSTREAM_INSTRUCTION.commitMarket, accounts, sequence); }
export function commitAndUndelegate(accounts: CommitAccounts, sequence: bigint | number): TransactionInstruction { return commitInstruction(STOCKSTREAM_INSTRUCTION.commitAndUndelegate, accounts, sequence); }
// There is no client-side `undelegationCallback` builder: the delegation
// program itself invokes StockStream via CPI using its own fixed
// `EXTERNAL_UNDELEGATE_DISCRIMINATOR` wire format
// (`[196, 28, 41, 206, 48, 37, 51, 167]`), never a transaction a client
// constructs. See `programs/stockstream/src/magicblock.rs::external_undelegate`.
/** Session action allowlist bits -- must match `session::SESSION_ACTION_*` exactly. */
export const SESSION_ACTION = {
  place: 1 << 0,
  cancel: 1 << 1,
  cancelAll: 1 << 2,
  replace: 1 << 3,
  /** Permits `PlaceOrder` only when the order carries the reduce-only flag. */
  reduceOnlyClose: 1 << 4,
} as const;

/**
 * Canonical `TradingSession` PDA: `["trading_session", owner, market,
 * seat_index_le, session_signer]`. Must match
 * `session::derive_trading_session` in the Rust program exactly.
 */
export function deriveTradingSession(owner: AddressInput, market: AddressInput, seatIndex: number, sessionSigner: AddressInput): PublicKey {
  const seatIndexBytes = new Uint8Array(2);
  new DataView(seatIndexBytes.buffer).setUint16(0, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("trading_session"), publicKey(owner).toBuffer(), publicKey(market).toBuffer(), Buffer.from(seatIndexBytes), publicKey(sessionSigner).toBuffer()],
    STOCKSTREAM_PROGRAM_KEY,
  )[0];
}

export interface TradingSessionAccounts extends InstructionAccounts { sessionSigner: AddressInput; payer: AddressInput; }
export interface SessionControlAccounts extends InstructionAccounts { session: AddressInput; sessionSigner: AddressInput; }
export interface TradingSessionPolicy { seatIndex: number; actions: number; maxOrderNotional: bigint | number; maxCumulativeNotional: bigint | number; maximumExposure: bigint | number; maximumOpenOrders: number; }

function sessionLimitsInstruction(discriminator: number, accounts: [AddressInput, boolean, boolean][], expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  if (!Number.isInteger(policy.seatIndex) || policy.seatIndex < 0 || policy.seatIndex > 0xffff || !Number.isInteger(policy.actions) || policy.actions <= 0 || policy.actions > 0xff || !Number.isInteger(policy.maximumOpenOrders) || policy.maximumOpenOrders <= 0 || policy.maximumOpenOrders > 0xffff) throw new RangeError("invalid trading session policy");
  const maxOrder = checkedUnsigned(policy.maxOrderNotional, 64, "maxOrderNotional");
  const maxCumulative = checkedUnsigned(policy.maxCumulativeNotional, 64, "maxCumulativeNotional");
  const maximumExposure = BigInt(policy.maximumExposure);
  if (maxOrder === 0n || maxCumulative < maxOrder || maximumExposure <= 0n || maximumExposure >= 2n ** 127n) throw new RangeError("invalid trading session limits");
  const data = new Uint8Array(46); const view = new DataView(data.buffer);
  data[0] = discriminator; view.setUint16(1, policy.seatIndex, true); writeUnsigned(data, 3, checkedUnsigned(expiresAt, 64, "expiresAt"), 8);
  data[11] = policy.actions; writeUnsigned(data, 12, maxOrder, 8); writeUnsigned(data, 20, maxCumulative, 8); writeSigned(data, 28, maximumExposure, 16); view.setUint16(44, policy.maximumOpenOrders, true);
  return instruction(data, accounts.map(([addr, isSigner, isWritable]) => accountMeta(addr, isSigner, isWritable)));
}

/**
 * Creates and initializes the canonical `TradingSession` PDA via a real
 * System Program CPI performed by the program itself (a PDA cannot sign a
 * top-level client transaction, so the client cannot pre-create this
 * account the way it could a keypair account). `next_expected_nonce`
 * always starts at `1`; there is no caller-supplied initial nonce.
 */
export function authorizeTradingSession(accounts: TradingSessionAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(
    STOCKSTREAM_INSTRUCTION.authorizeTradingSession,
    [
      [accounts.market, false, true],
      [accounts.payer, true, true],
      [deriveTradingSession(accounts.authority, accounts.market, policy.seatIndex, accounts.sessionSigner), false, true],
      [accounts.sessionSigner, false, false],
      [SystemProgram.programId, false, false],
    ],
    expiresAt,
    policy,
  );
}

/** Never callable by the session signer itself -- only the owner (`accounts.authority`) may tighten or loosen limits, and a revoked session cannot be updated back to life. */
export function updateTradingSessionLimits(accounts: SessionControlAccounts, expiresAt: bigint | number, policy: TradingSessionPolicy): TransactionInstruction {
  return sessionLimitsInstruction(
    STOCKSTREAM_INSTRUCTION.updateTradingSessionLimits,
    [
      [accounts.market, false, true],
      [accounts.authority, true, false],
      [accounts.session, false, true],
      [accounts.sessionSigner, false, false],
    ],
    expiresAt,
    policy,
  );
}

export function revokeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.revokeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]); }

/** Reclaims the session PDA's rent to the owner. Only callable once the session is revoked or expired. */
export function closeTradingSession(accounts: SessionControlAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.closeTradingSession; new DataView(data.buffer).setUint16(1, Number(checkedUnsigned(seatIndex, 16, "seatIndex")), true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, true), accountMeta(accounts.session, false, true), accountMeta(accounts.sessionSigner, false, false)]); }

function identifierInstruction(discriminator: number, identifier: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  if (identifier.length !== 32) throw new RangeError("identifier must be 32 bytes");
  const data = new Uint8Array(33); data[0] = discriminator; data.set(identifier, 1); return instruction(data, accounts);
}
export function initializeExchange(accounts: RegistryAccounts): TransactionInstruction { return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeExchange), [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]); }
export function registerStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.registerStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function createPerpMarket(accounts: PerpMarketAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.createPerpMarket, instrumentId, [accountMeta(accounts.instrument, false, false), accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
/**
 * Creates or resumes exactly one committable V3 account. For a book page,
 * the target is 10,184 bytes and completes in one System CPI; retries after
 * completion are idempotent. The builder validates the target PDA so a
 * client cannot accidentally point this isolated V3 flow at the V2 market.
 */
export function createV3Account(accounts: V3CreationAccounts, kind: V3AccountKind, index = 0): TransactionInstruction {
  const parent = publicKey(accounts.parent);
  const target = publicKey(accounts.target);
  const kindAndIndex: Record<V3AccountKind, [number, number]> = {
    core: [0, 0],
    "book-page": [1, index],
    "seat-shard": [2, index],
    "event-shard": [3, index],
  };
  const [kindByte, flattenedIndex] = kindAndIndex[kind];
  if (!Number.isInteger(flattenedIndex) || flattenedIndex < 0 || flattenedIndex > (kindByte === 1 ? 2 * V3_BOOK_PAGES_PER_SIDE - 1 : kindByte === 0 ? 0 : 3)) throw new RangeError("invalid V3 account index");
  const expected = kindByte === 0 ? deriveMarketCoreV3(parent)
    : kindByte === 1 ? deriveBookPageV3(parent, Math.floor(flattenedIndex / V3_BOOK_PAGES_PER_SIDE), flattenedIndex % V3_BOOK_PAGES_PER_SIDE)
      : kindByte === 2 ? deriveSeatShardV3(parent, flattenedIndex)
        : deriveEventShardV3(parent, flattenedIndex);
  if (!target.equals(expected)) throw new RangeError("target is not the derived V3 account PDA");
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.createV3Account, kindByte, flattenedIndex), [
    accountMeta(parent, false, false), accountMeta(target, false, true),
    accountMeta(accounts.payer, true, true), accountMeta(SystemProgram.programId, false, false),
  ]);
}
/** Activates a structural V3 core under the immutable exchange listing authority. */
export function initializeV3Market(accounts: V3InitializationAccounts): TransactionInstruction {
  const instrument = publicKey(accounts.instrument);
  if (!publicKey(accounts.core).equals(deriveMarketCoreV3(instrument))) throw new RangeError("core is not the derived V3 market PDA");
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeV3Market), [
    accountMeta(accounts.exchange, false, false), accountMeta(instrument, false, false),
    accountMeta(accounts.core, false, true), accountMeta(accounts.authority, true, false),
  ]);
}
/**
 * Delegates one V3 account through the real Delegation Program. Delegate the
 * activated core first; then delegate pages/shards using that core as parent.
 * Book pages may need repeated calls while their individual delegate buffer
 * grows, exactly as the on-chain instruction documents.
 */
export function delegateV3Account(accounts: V3DelegationAccounts, kind: V3AccountKind, validator: AddressInput, index = 0): TransactionInstruction {
  const parent = publicKey(accounts.parent);
  const target = publicKey(accounts.target);
  const validatorKey = publicKey(validator);
  const kindAndIndex: Record<V3AccountKind, [number, number]> = {
    core: [0, 0], "book-page": [1, index], "seat-shard": [2, index], "event-shard": [3, index],
  };
  const [kindByte, flattenedIndex] = kindAndIndex[kind];
  if (!Number.isInteger(flattenedIndex) || flattenedIndex < 0 || flattenedIndex > (kindByte === 1 ? 2 * V3_BOOK_PAGES_PER_SIDE - 1 : kindByte === 0 ? 0 : 3)) throw new RangeError("invalid V3 account index");
  const expected = kindByte === 0 ? deriveMarketCoreV3(parent)
    : kindByte === 1 ? deriveBookPageV3(parent, Math.floor(flattenedIndex / V3_BOOK_PAGES_PER_SIDE), flattenedIndex % V3_BOOK_PAGES_PER_SIDE)
      : kindByte === 2 ? deriveSeatShardV3(parent, flattenedIndex) : deriveEventShardV3(parent, flattenedIndex);
  if (!target.equals(expected)) throw new RangeError("target is not the derived V3 account PDA");
  const [buffer] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), target.toBuffer()], STOCKSTREAM_PROGRAM_KEY);
  const [record] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), target.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), target.toBuffer()], MAGICBLOCK_DELEGATION_PROGRAM_ID);
  const data = new Uint8Array(35); data[0] = STOCKSTREAM_INSTRUCTION.delegateV3Account; data[1] = kindByte; data[2] = flattenedIndex; data.set(validatorKey.toBytes(), 3);
  return instruction(data, [
    accountMeta(parent, false, false), accountMeta(target, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.payer, true, true),
    accountMeta(buffer, false, true), accountMeta(record, false, true), accountMeta(metadata, false, true),
    accountMeta(MAGICBLOCK_DELEGATION_PROGRAM_ID, false, false), accountMeta(SystemProgram.programId, false, false), accountMeta(STOCKSTREAM_PROGRAM_KEY, false, false),
  ]);
}
/** Creates a V3 trader seat. All four shards are required so the program can
 * reject duplicate ownership across the full 128-seat domain. */
export function createV3TraderSeat(accounts: V3SeatAccounts, seatIndex: number): TransactionInstruction {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= 128) throw new RangeError("invalid V3 seat index");
  if (accounts.seatShards.length !== 4) throw new RangeError("exactly four V3 seat shards are required");
  if (accounts.eventShards.length !== 4) throw new RangeError("exactly four V3 event shards are required");
  const core = publicKey(accounts.core);
  const shards = accounts.seatShards.map(publicKey);
  const events = accounts.eventShards.map(publicKey);
  for (let index = 0; index < 4; index += 1) if (!shards[index].equals(deriveSeatShardV3(core, index))) throw new RangeError("seat shard is not the derived V3 PDA");
  for (let index = 0; index < 4; index += 1) if (!events[index].equals(deriveEventShardV3(core, index))) throw new RangeError("event shard is not the derived V3 PDA");
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.createV3TraderSeat; new DataView(data.buffer).setUint16(1, seatIndex, true);
  return instruction(data, [accountMeta(core, false, true), ...shards.map((shard) => accountMeta(shard, false, true)), ...events.map((event) => accountMeta(event, false, true)), accountMeta(accounts.trader, true, false)]);
}
/** Closes an empty V3 trader seat owned by `trader`. */
export function closeV3TraderSeat(accounts: V3SeatAccounts, seatIndex: number): TransactionInstruction {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= 128) throw new RangeError("invalid V3 seat index");
  if (accounts.seatShards.length !== 4) throw new RangeError("exactly four V3 seat shards are required");
  if (accounts.eventShards.length !== 4) throw new RangeError("exactly four V3 event shards are required");
  const core = publicKey(accounts.core);
  const shards = accounts.seatShards.map(publicKey);
  const events = accounts.eventShards.map(publicKey);
  for (let index = 0; index < 4; index += 1) if (!shards[index].equals(deriveSeatShardV3(core, index))) throw new RangeError("seat shard is not the derived V3 PDA");
  for (let index = 0; index < 4; index += 1) if (!events[index].equals(deriveEventShardV3(core, index))) throw new RangeError("event shard is not the derived V3 PDA");
  const data = new Uint8Array(3); data[0] = STOCKSTREAM_INSTRUCTION.closeV3TraderSeat; new DataView(data.buffer).setUint16(1, seatIndex, true);
  return instruction(data, [accountMeta(core, false, true), ...shards.map((shard) => accountMeta(shard, false, true)), ...events.map((event) => accountMeta(event, false, true)), accountMeta(accounts.trader, true, false)]);
}
export function updateStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array, pythFeedId: number, oracleChannel: number, priceExponent: number): TransactionInstruction { if (!Number.isInteger(pythFeedId) || pythFeedId <= 0 || pythFeedId > 0xffff_ffff) throw new RangeError("pythFeedId must be a non-zero u32"); if (!Number.isInteger(oracleChannel) || oracleChannel < 1 || oracleChannel > 4) throw new RangeError("oracleChannel must be between 1 and 4"); const data = new Uint8Array(42); const view = new DataView(data.buffer); data[0] = STOCKSTREAM_INSTRUCTION.updateStockInstrument; data.set(instrumentId, 1); view.setUint32(33, pythFeedId, true); data[37] = oracleChannel; view.setInt32(38, priceExponent, true); return instruction(data, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function suspendStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.suspendStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function updateMarketRisk(accounts: InstructionAccounts, initial: number, maintenance: number, leverage: number): TransactionInstruction { const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.updateMarketRisk; const view = new DataView(data.buffer); view.setUint16(1, initial, true); view.setUint16(3, maintenance, true); view.setUint32(5, leverage, true); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function transitionMarket(accounts: InstructionAccounts, mode: "pause" | "resume" | "close-only" | "corporate-action" | "resolve" | "close"): TransactionInstruction { const discriminator = { pause: STOCKSTREAM_INSTRUCTION.pauseMarket, resume: STOCKSTREAM_INSTRUCTION.resumeMarket, "close-only": STOCKSTREAM_INSTRUCTION.setCloseOnly, "corporate-action": STOCKSTREAM_INSTRUCTION.enterCorporateAction, resolve: STOCKSTREAM_INSTRUCTION.resolveCorporateAction, close: STOCKSTREAM_INSTRUCTION.closeMarket }[mode]; return instruction(Uint8Array.of(discriminator), [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }

export function decodeInstruction(data: Uint8Array): InstructionFixture {
  if (data.length === 0) throw new RangeError("Empty instruction");
  const names: Record<number, string> = { 0: "InitializeMarket", 1: "CreateTraderSeat", 2: "CloseTraderSeat", 3: "PlaceOrder", 4: "CancelOrder", 5: "CancelAll", 6: "UpdateFunding", 7: "Liquidate", 8: "InitializeSettlementScratch", 9: "InitializeVault", 10: "DepositCollateral", 11: "WithdrawCollateral", 12: "ConsumeOracleUpdate", 13: "DelegateMarket", 14: "CommitMarket", 15: "CommitAndUndelegate", 16: "UndelegationCallback", 17: "AuthorizeTradingSession", 18: "RevokeTradingSession", 19: "InitializeExchange", 20: "RegisterStockInstrument", 21: "CreatePerpMarket", 22: "UpdateStockInstrument", 23: "SuspendStockInstrument", 24: "UpdateMarketRisk", 25: "PauseMarket", 26: "ResumeMarket", 27: "SetCloseOnly", 28: "EnterCorporateAction", 29: "ResolveCorporateAction", 30: "CloseMarket", 31: "UpdateTradingSessionLimits", 32: "CloseTradingSession", 33: "ReplaceOrder", 34: "TransferToInsuranceFund", 35: "WithdrawProtocolFees", 36: "WithdrawInsuranceFunds", 37: "RecordBadDebt", 38: "ResolveBadDebt", 39: "ReconcileVault", 40: "UpdateExchangeConfig", 41: "DelegateClusterMember", 42: "CreateMarketAccount", 43: "CreateInstrumentAccount", 44: "CreateVaultAccount", 45: "CreateScratchAccount", 46: "CreateV3Account", 47: "InitializeV3Market", 48: "DelegateV3Account", 49: "CreateV3TraderSeat", 50: "CloseV3TraderSeat" };
  const name = names[data[0]];
  if (!name) throw new RangeError("Unknown instruction");
  return { name, data: data.slice() };
}

export interface MarketStateView {
  discriminator: string;
  version: number;
  initialized: boolean;
  mode: number;
  marketAuthority: PublicKey;
  /** Required signer for `Liquidate` (`handlers::liquidate` checks `authority == header.emergency_authority`). */
  emergencyAuthority: PublicKey;
  maintenanceMarginBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  currentOpenInterest: bigint;
  globalEventSequence: bigint;
  fundingAccumulator: bigint;
  lastFundingTimestamp: bigint;
  oracleValid: boolean;
  lastVerifiedOraclePrice: bigint;
  lastVerifiedOracleTimestamp: bigint;
  bidArenaOffset: number;
  askArenaOffset: number;
  traderSeatOffset: number;
  fillEventOffset: number;
  /** `reserved_upgrade[122..130]`, byte 449. See `docs/program-layout.md`. */
  protocolFeeBalance: bigint;
  /** `reserved_upgrade[130..138]`, byte 457. */
  insuranceFundBalance: bigint;
  /** `reserved_upgrade[138..146]`, byte 465. */
  recognizedBadDebt: bigint;
  /** `reserved_upgrade[146]`, byte 473. 0=Reconciled 1=SurplusDetected 2=DeficitDetected 3=RecoveryRequired. */
  reconciliationStatus: number;
  /** `reserved_upgrade[147..155]`, byte 474. */
  vaultSurplus: bigint;
}

/** `MARKET_VERSION` in `state.rs`. Bumped from `1` to `2` when
 * `reserved_upgrade[122..155]` (previously unused scratch space) became
 * permanent protocol fields for custody fee/insurance/reconciliation
 * accounting (Priority 4) -- see `docs/program-layout.md`. A `version: 1`
 * account predates those fields entirely and is rejected outright rather
 * than silently read as if they were present. */
const CURRENT_MARKET_VERSION = 2;

export function decodeMarketState(data: Uint8Array): MarketStateView {
  if (data.byteLength !== STOCKSTREAM_ACCOUNT_SIZE) throw new RangeError("Invalid StockStream market account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytes = data.slice(0, 8); const discriminator = new TextDecoder().decode(bytes);
  const version = view.getUint16(8, true);
  if (discriminator !== "STKMRK01" || version !== CURRENT_MARKET_VERSION) throw new RangeError("Invalid StockStream market header");
  if (view.getUint32(311, true) !== 512 || view.getUint32(315, true) !== 91152 ||
      view.getUint32(319, true) !== 181792 || view.getUint32(323, true) !== 214560)
    throw new RangeError('Invalid StockStream regions');
  return {
    discriminator, version,
    initialized: view.getUint8(10) === 1,
    mode: view.getUint8(11),
    marketAuthority: new PublicKey(data.slice(12, 44)),
    emergencyAuthority: new PublicKey(data.slice(76, 108)),
    maintenanceMarginBps: view.getUint16(194, true),
    makerFeeBps: view.getUint16(198, true),
    takerFeeBps: view.getUint16(200, true),
    currentOpenInterest: readSignedLE(data, 238, 16),
    globalEventSequence: view.getBigUint64(262, true),
    fundingAccumulator: readSignedLE(data, 270, 16),
    lastFundingTimestamp: view.getBigUint64(286, true),
    oracleValid: view.getUint8(294) === 1,
    lastVerifiedOraclePrice: view.getBigInt64(295, true),
    lastVerifiedOracleTimestamp: view.getBigUint64(303, true),
    bidArenaOffset: view.getUint32(311, true), askArenaOffset: view.getUint32(315, true), traderSeatOffset: view.getUint32(319, true), fillEventOffset: view.getUint32(323, true),
    protocolFeeBalance: view.getBigUint64(449, true), insuranceFundBalance: view.getBigUint64(457, true), recognizedBadDebt: view.getBigUint64(465, true), reconciliationStatus: view.getUint8(473), vaultSurplus: view.getBigUint64(474, true),
  };
}

export interface BookMetadata { version: number; fixedRoot: number; peggedRoot: number; fixedLeaves: number; peggedLeaves: number; bumpIndex: number; freeHead: number; freeLength: number; }
export function decodeBookMetadata(data: Uint8Array): BookMetadata {
  if (data.byteLength < 32) throw new RangeError("Invalid book region");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { version: view.getUint32(0, true), fixedRoot: view.getUint32(4, true), peggedRoot: view.getUint32(8, true), fixedLeaves: view.getUint32(12, true), peggedLeaves: view.getUint32(16, true), bumpIndex: view.getUint32(20, true), freeHead: view.getUint32(24, true), freeLength: view.getUint32(28, true) };
}

export interface FillEventView { sequence: bigint; maker: number; taker: number; price: bigint; quantity: bigint; }
export function decodeFillEvent(data: Uint8Array): FillEventView {
  if (data.byteLength !== 64) throw new RangeError("Invalid fill event size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { sequence: view.getBigUint64(0, true), maker: view.getUint32(8, true), taker: view.getUint32(12, true), price: view.getBigInt64(16, true), quantity: view.getBigUint64(24, true) };
}

function readSignedLE(data: Uint8Array, offset: number, bytes: number): bigint {
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]);
  const signBit = 1n << BigInt(bytes * 8 - 1);
  return value >= signBit ? value - (signBit << 1n) : value;
}

export interface TradingSessionView {
  discriminator: string;
  version: number;
  initialized: boolean;
  revoked: boolean;
  owner: PublicKey;
  sessionSigner: PublicKey;
  targetProgram: PublicKey;
  market: PublicKey;
  traderSeatIndex: number;
  createdAt: bigint;
  expiresAt: bigint;
  actions: number;
  maxOrderNotional: bigint;
  maxCumulativeNotional: bigint;
  consumedCumulativeNotional: bigint;
  maxExposure: bigint;
  maxOpenOrders: number;
  nextExpectedNonce: bigint;
  lastActionTimestamp: bigint;
  sessionGeneration: number;
}

/** Must match `session::TradingSession`'s packed byte layout exactly. */
export function decodeTradingSession(data: Uint8Array): TradingSessionView {
  if (data.byteLength !== STOCKSTREAM_TRADING_SESSION_SIZE) throw new RangeError("Invalid TradingSession account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const discriminator = new TextDecoder().decode(data.slice(0, 8));
  if (discriminator !== "STKSES02" || view.getUint16(8, true) !== 1) throw new RangeError("Invalid TradingSession header");
  return {
    discriminator,
    version: view.getUint16(8, true),
    initialized: view.getUint8(10) === 1,
    revoked: view.getUint8(11) === 1,
    owner: new PublicKey(data.slice(12, 44)),
    sessionSigner: new PublicKey(data.slice(44, 76)),
    targetProgram: new PublicKey(data.slice(76, 108)),
    market: new PublicKey(data.slice(108, 140)),
    traderSeatIndex: view.getUint16(140, true),
    createdAt: view.getBigUint64(142, true),
    expiresAt: view.getBigUint64(150, true),
    actions: view.getUint8(158),
    maxOrderNotional: view.getBigUint64(159, true),
    maxCumulativeNotional: view.getBigUint64(167, true),
    consumedCumulativeNotional: view.getBigUint64(175, true),
    maxExposure: readSignedLE(data, 183, 16),
    maxOpenOrders: view.getUint16(199, true),
    nextExpectedNonce: view.getBigUint64(201, true),
    lastActionTimestamp: view.getBigUint64(209, true),
    sessionGeneration: view.getUint32(217, true),
  };
}

export function previewPlaceOrder(params: PlaceOrderParams) {
  const tx = placeOrder(params);
  return { programId: STOCKSTREAM_PROGRAM_ID, instruction: "PlaceOrder", accounts: tx.keys.map((account) => ({ address: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable })), signers: tx.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58()), side: params.side, quantity: String(params.quantity), limitPrice: String(params.priceOrOffset), estimatedInternalMargin: "Unavailable until verified oracle pricing" };
}

export { SystemProgram };
