import { TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { accountMeta, instruction, type AddressInput } from "./transaction";

export interface RegistryAccounts { exchange: AddressInput; authority: AddressInput; }
export interface InstrumentAccounts { exchange: AddressInput; instrument: AddressInput; authority: AddressInput; }
export interface PerpMarketAccounts { instrument: AddressInput; market: AddressInput; authority: AddressInput; }
export interface MarketAuthorityAccounts { market: AddressInput; authority: AddressInput; }

function identifierInstruction(discriminator: number, identifier: Uint8Array, accounts: ReturnType<typeof accountMeta>[]): TransactionInstruction {
  if (identifier.length !== 32) throw new RangeError("identifier must be 32 bytes");
  const data = new Uint8Array(33); data[0] = discriminator; data.set(identifier, 1);
  return instruction(data, accounts);
}

export function initializeExchange(accounts: RegistryAccounts): TransactionInstruction {
  return instruction(Uint8Array.of(OPCODE.initializeExchange), [accountMeta(accounts.exchange, false, true), accountMeta(accounts.authority, true, false)]);
}

export function registerStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction {
  return identifierInstruction(OPCODE.registerStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, true), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]);
}

export function createPerpMarket(accounts: PerpMarketAccounts, instrumentId: Uint8Array): TransactionInstruction {
  return identifierInstruction(OPCODE.createPerpMarket, instrumentId, [accountMeta(accounts.instrument, false, false), accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export function updateStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array, pythFeedId: number, oracleChannel: number, priceExponent: number): TransactionInstruction {
  if (!Number.isInteger(pythFeedId) || pythFeedId <= 0 || pythFeedId > 0xffff_ffff) throw new RangeError("pythFeedId must be a non-zero u32");
  if (!Number.isInteger(oracleChannel) || oracleChannel < 1 || oracleChannel > 4) throw new RangeError("oracleChannel must be between 1 and 4");
  const data = new Uint8Array(42); const view = new DataView(data.buffer);
  data[0] = OPCODE.updateStockInstrument; data.set(instrumentId, 1); view.setUint32(33, pythFeedId, true); data[37] = oracleChannel; view.setInt32(38, priceExponent, true);
  return instruction(data, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]);
}

export function suspendStockInstrument(accounts: InstrumentAccounts, instrumentId: Uint8Array): TransactionInstruction {
  return identifierInstruction(OPCODE.suspendStockInstrument, instrumentId, [accountMeta(accounts.exchange, false, false), accountMeta(accounts.instrument, false, true), accountMeta(accounts.authority, true, false)]);
}

export function updateMarketRisk(accounts: MarketAuthorityAccounts, initial: number, maintenance: number, leverage: number): TransactionInstruction {
  const data = new Uint8Array(9); data[0] = OPCODE.updateMarketRisk; const view = new DataView(data.buffer);
  view.setUint16(1, initial, true); view.setUint16(3, maintenance, true); view.setUint32(5, leverage, true);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

export interface V3RiskUpdate {
  initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number;
  makerFeeBps: number; takerFeeBps: number; maximumLeverage: number;
  maximumPosition: bigint; maximumOpenInterest: bigint; markDeviationBps: number;
}

/** V3 uses the same risk opcode with a versioned 49-byte payload and a
 * `[core, authority]` account pair. The legacy 9-byte builder above remains
 * V2-only and is intentionally not widened. */
export function updateV3Risk(accounts: MarketAuthorityAccounts, values: V3RiskUpdate): TransactionInstruction {
  const data = new Uint8Array(49); const view = new DataView(data.buffer); data[0] = OPCODE.updateMarketRisk;
  view.setUint16(1, values.initialMarginBps, true); view.setUint16(3, values.maintenanceMarginBps, true);
  view.setUint16(5, values.liquidationFeeBps, true); view.setUint16(7, values.makerFeeBps, true); view.setUint16(9, values.takerFeeBps, true);
  view.setUint32(11, values.maximumLeverage, true);
  writeSigned128(view, 15, values.maximumPosition); writeSigned128(view, 31, values.maximumOpenInterest);
  view.setUint16(47, values.markDeviationBps, true);
  return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}

function writeSigned128(view: DataView, offset: number, value: bigint): void {
  const normalized = value < 0n ? (1n << 128n) + value : value;
  view.setBigUint64(offset, normalized & ((1n << 64n) - 1n), true);
  view.setBigUint64(offset + 8, normalized >> 64n, true);
}

export type MarketTransition = "pause" | "resume" | "close-only" | "corporate-action" | "resolve" | "close";
export function transitionMarket(accounts: MarketAuthorityAccounts, mode: MarketTransition): TransactionInstruction {
  const discriminator = { pause: OPCODE.pauseMarket, resume: OPCODE.resumeMarket, "close-only": OPCODE.setCloseOnly, "corporate-action": OPCODE.enterCorporateAction, resolve: OPCODE.resolveCorporateAction, close: OPCODE.closeMarket }[mode];
  return instruction(Uint8Array.of(discriminator), [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]);
}
