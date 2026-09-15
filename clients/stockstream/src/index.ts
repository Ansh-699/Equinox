import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { STOCKSTREAM_ACCOUNT_SIZE, STOCKSTREAM_INSTRUCTION, STOCKSTREAM_PROGRAM_ID } from "./constants";

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
  postOnly?: boolean;
  immediateOrCancel?: boolean;
  reduceOnly?: boolean;
}

export interface InstructionFixture {
  name: string;
  data: Uint8Array;
}

export interface VaultAccounts { market: AddressInput; authority: AddressInput; mint: AddressInput; tokenProgram: AddressInput; vault: AddressInput; vaultAuthority: AddressInput; }
export interface CustodyAccounts extends VaultAccounts { seat: AddressInput; sourceOrDestination: AddressInput; }
export interface DelegationAccounts { market: AddressInput; authority: AddressInput; hotAccounts: AddressInput[]; }
export interface RegistryAccounts { exchange: AddressInput; authority: AddressInput; }
export interface InstrumentAccounts { exchange: AddressInput; instrument: AddressInput; authority: AddressInput; }
export interface PerpMarketAccounts { instrument: AddressInput; market: AddressInput; authority: AddressInput; }

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
  const data = new Uint8Array(46);
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
  return instruction(data, [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)]);
}

export function cancelOrder(accounts: InstructionAccounts, seatIndex: number, orderKey: bigint): TransactionInstruction {
  const data = new Uint8Array(19); data[0] = STOCKSTREAM_INSTRUCTION.cancelOrder; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function cancelAll(accounts: InstructionAccounts, seatIndex: number, maxCancellations: number): TransactionInstruction {
  const data = new Uint8Array(4); data[0] = STOCKSTREAM_INSTRUCTION.cancelAll; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations"));
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
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
  const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(amount, 64, "amount"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.seat, false, true), accountMeta(accounts.sourceOrDestination, false, true), accountMeta(accounts.vault, false, true), accountMeta(accounts.mint, false, false), accountMeta(accounts.tokenProgram, false, false)]);
}
export function depositCollateral(accounts: CustodyAccounts, amount: bigint | number) { return amountInstruction(STOCKSTREAM_INSTRUCTION.depositCollateral, accounts, amount); }
export function withdrawCollateral(accounts: CustodyAccounts, amount: bigint | number) { return amountInstruction(STOCKSTREAM_INSTRUCTION.withdrawCollateral, accounts, amount); }

export function consumeOracleUpdate(accounts: { market: AddressInput; pythProgram: AddressInput; storage: AddressInput; treasury: AddressInput; instructionsSysvar: AddressInput; payload: AddressInput }): TransactionInstruction {
  return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.consumeOracleUpdate), [accountMeta(accounts.market, false, true), accountMeta(accounts.pythProgram, false, false), accountMeta(accounts.storage, false, false), accountMeta(accounts.treasury, false, false), accountMeta(accounts.instructionsSysvar, false, false), accountMeta(accounts.payload, false, false)]);
}
export function delegateMarket(accounts: DelegationAccounts, sequence: bigint | number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.delegateMarket; writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), ...accounts.hotAccounts.map((a) => accountMeta(a, false, true))]);
}
export function commitMarket(accounts: InstructionAccounts, sequence: bigint | number): TransactionInstruction { return controlInstruction(STOCKSTREAM_INSTRUCTION.commitMarket, accounts, sequence); }
export function commitAndUndelegate(accounts: InstructionAccounts, sequence: bigint | number): TransactionInstruction { return controlInstruction(STOCKSTREAM_INSTRUCTION.commitAndUndelegate, accounts, sequence); }
function controlInstruction(discriminator: number, accounts: InstructionAccounts, sequence: bigint | number) { const data = new Uint8Array(9); data[0] = discriminator; writeUnsigned(data, 1, checkedUnsigned(sequence, 64, "sequence"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function undelegationCallback(accounts: InstructionAccounts, sequence: bigint | number): TransactionInstruction { const data = new Uint8Array(17); data[0] = STOCKSTREAM_INSTRUCTION.undelegationCallback; data.set([196, 28, 41, 206, 48, 37, 51, 167], 1); writeUnsigned(data, 9, checkedUnsigned(sequence, 64, "sequence"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, false, false)]); }
export function authorizeTradingSession(accounts: InstructionAccounts, expiresAt: bigint | number, nonce: bigint | number): TransactionInstruction { const data = new Uint8Array(17); data[0] = STOCKSTREAM_INSTRUCTION.authorizeTradingSession; writeUnsigned(data, 1, checkedUnsigned(expiresAt, 64, "expiresAt"), 8); writeUnsigned(data, 9, checkedUnsigned(nonce, 64, "nonce"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function revokeTradingSession(accounts: InstructionAccounts, nonce: bigint | number): TransactionInstruction { const data = new Uint8Array(9); data[0] = STOCKSTREAM_INSTRUCTION.revokeTradingSession; writeUnsigned(data, 1, checkedUnsigned(nonce, 64, "nonce"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }

function identifierInstruction(discriminator: number, identifier: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  if (identifier.length !== 32) throw new RangeError("identifier must be 32 bytes");
  const data = new Uint8Array(33); data[0] = discriminator; data.set(identifier, 1); return instruction(data, accounts);
}
export function initializeExchange(accounts: RegistryAccounts): TransactionInstruction { return instruction(Uint8Array.of(STOCKSTREAM_INSTRUCTION.initializeExchange), [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]); }
export function registerStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.registerStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]); }
export function createPerpMarket(accounts: PerpMarketAccounts, instrumentId: Uint8Array): TransactionInstruction { return identifierInstruction(STOCKSTREAM_INSTRUCTION.createPerpMarket, instrumentId, [accountMeta(accounts.instrument, false, false), accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }

export function decodeInstruction(data: Uint8Array): InstructionFixture {
  if (data.length === 0) throw new RangeError("Empty instruction");
  const names: Record<number, string> = { 0: "InitializeMarket", 1: "CreateTraderSeat", 2: "CloseTraderSeat", 3: "PlaceOrder", 4: "CancelOrder", 5: "CancelAll", 6: "UpdateFunding", 7: "Liquidate", 8: "InitializeSettlementScratch", 9: "InitializeVault", 10: "DepositCollateral", 11: "WithdrawCollateral", 12: "ConsumeOracleUpdate", 13: "DelegateMarket", 14: "CommitMarket", 15: "CommitAndUndelegate", 16: "UndelegationCallback", 17: "AuthorizeTradingSession", 18: "RevokeTradingSession", 19: "InitializeExchange", 20: "RegisterStockInstrument", 21: "CreatePerpMarket" };
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
  oracleValid: boolean;
  lastVerifiedOraclePrice: bigint;
  lastVerifiedOracleTimestamp: bigint;
  bidArenaOffset: number;
  askArenaOffset: number;
  traderSeatOffset: number;
  fillEventOffset: number;
}

export function decodeMarketState(data: Uint8Array): MarketStateView {
  if (data.byteLength !== STOCKSTREAM_ACCOUNT_SIZE) throw new RangeError("Invalid StockStream market account size");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytes = data.slice(0, 8); const discriminator = new TextDecoder().decode(bytes);
  if (discriminator !== "STKMRK01" || view.getUint16(8, true) !== 1) throw new RangeError("Invalid StockStream market header");
  return { discriminator, version: 1, initialized: view.getUint8(10) === 1, mode: view.getUint8(11), marketAuthority: new PublicKey(data.slice(12, 44)), oracleValid: view.getUint8(270) === 1, lastVerifiedOraclePrice: view.getBigInt64(271, true), lastVerifiedOracleTimestamp: view.getBigUint64(279, true), bidArenaOffset: view.getUint32(287, true), askArenaOffset: view.getUint32(291, true), traderSeatOffset: view.getUint32(295, true), fillEventOffset: view.getUint32(299, true) };
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

export function previewPlaceOrder(params: PlaceOrderParams) {
  const tx = placeOrder(params);
  return { programId: STOCKSTREAM_PROGRAM_ID, instruction: "PlaceOrder", accounts: tx.keys.map((account) => ({ address: account.pubkey.toBase58(), signer: account.isSigner, writable: account.isWritable })), signers: tx.keys.filter((account) => account.isSigner).map((account) => account.pubkey.toBase58()), side: params.side, quantity: String(params.quantity), limitPrice: String(params.priceOrOffset), estimatedInternalMargin: "Unavailable until verified oracle pricing" };
}

export { SystemProgram };
