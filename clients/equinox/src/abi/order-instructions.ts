import { TransactionInstruction } from "@solana/web3.js";
import { OPCODE } from "./instructions";
import { checkedSigned, checkedUnsigned, writeSigned, writeUnsigned } from "./encoding";
import { accountMeta, instruction, type AddressInput } from "./transaction";

export type Side = "bid" | "ask";
export type OrderTree = "fixed" | "oracle-pegged";
export type SelfTradeBehavior = "abort" | "cancel-provide" | "decrement-take";
export interface InstructionAccounts { market: AddressInput; authority: AddressInput; }
export interface PlaceOrderParams extends InstructionAccounts {
  settlementScratch: AddressInput; seatIndex: number; side: Side; tree?: OrderTree;
  quantity: bigint | number; priceOrOffset: bigint | number; expiresAt?: bigint | number; pegLimit?: bigint | number;
  clientOrderId: bigint | number; actionNonce?: bigint | number; postOnly?: boolean; immediateOrCancel?: boolean; reduceOnly?: boolean;
  selfTradeBehavior?: SelfTradeBehavior; session?: AddressInput;
}
export interface SessionAuthorizedAccounts extends InstructionAccounts { session?: AddressInput; }

function selfTradeBits(value: SelfTradeBehavior = "abort"): number {
  return value === "abort" ? 0 : value === "cancel-provide" ? 1 << 3 : value === "decrement-take" ? 2 << 3 : (() => { throw new RangeError("Invalid self-trade behavior"); })();
}

export function initializeMarket(accounts: InstructionAccounts): TransactionInstruction { return instruction(Uint8Array.of(OPCODE.initializeMarket), [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function createTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = OPCODE.createTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function initializeSettlementScratch(accounts: InstructionAccounts & { settlementScratch: AddressInput }, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = OPCODE.initializeSettlementScratch; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false), accountMeta(accounts.settlementScratch, false, true)]); }
export function closeTraderSeat(accounts: InstructionAccounts, seatIndex: number): TransactionInstruction { const data = new Uint8Array(3); data[0] = OPCODE.closeTraderSeat; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }

export function placeOrder(params: PlaceOrderParams): TransactionInstruction {
  const data = new Uint8Array(54); data[0] = OPCODE.placeOrder; data[1] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255; data[2] = (params.tree ?? "fixed") === "fixed" ? 0 : 1;
  data[3] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0) | selfTradeBits(params.selfTradeBehavior); if (data[1] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 4, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 6, checkedUnsigned(params.quantity, 64, "quantity"), 8); writeSigned(data, 14, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8); writeUnsigned(data, 22, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8); writeSigned(data, 30, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8); writeUnsigned(data, 38, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0; if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero"); writeUnsigned(data, 46, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)]; if (params.session) accounts.push(accountMeta(params.session, false, true)); return instruction(data, accounts);
}

export function replaceOrder(params: PlaceOrderParams & { oldOrderKey: bigint }): TransactionInstruction {
  const data = new Uint8Array(70); data[0] = OPCODE.replaceOrder; writeUnsigned(data, 1, checkedUnsigned(params.oldOrderKey, 128, "oldOrderKey"), 16); data[17] = params.side === "bid" ? 0 : params.side === "ask" ? 1 : 255; data[18] = (params.tree ?? "fixed") === "fixed" ? 0 : 1; data[19] = (params.postOnly ? 1 : 0) | (params.immediateOrCancel ? 2 : 0) | (params.reduceOnly ? 4 : 0) | selfTradeBits(params.selfTradeBehavior); if (data[17] > 1) throw new RangeError("Invalid order side");
  writeUnsigned(data, 20, checkedUnsigned(params.seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 22, checkedUnsigned(params.quantity, 64, "quantity"), 8); writeSigned(data, 30, checkedSigned(params.priceOrOffset, 64, "priceOrOffset"), 8); writeUnsigned(data, 38, checkedUnsigned(params.expiresAt ?? 0, 64, "expiresAt"), 8); writeSigned(data, 46, checkedSigned(params.pegLimit ?? 0, 64, "pegLimit"), 8); writeUnsigned(data, 54, checkedUnsigned(params.clientOrderId, 64, "clientOrderId"), 8);
  const actionNonce = params.actionNonce ?? 0; if (!params.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero"); writeUnsigned(data, 62, checkedUnsigned(actionNonce, 64, "actionNonce"), 8);
  const accounts = [accountMeta(params.market, false, true), accountMeta(params.authority, true, false), accountMeta(params.settlementScratch, false, true)]; if (params.session) accounts.push(accountMeta(params.session, false, true)); return instruction(data, accounts);
}

export function cancelOrder(accounts: SessionAuthorizedAccounts, seatIndex: number, orderKey: bigint, actionNonce: bigint | number = 0): TransactionInstruction { if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero"); const data = new Uint8Array(27); data[0] = OPCODE.cancelOrder; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(orderKey, 128, "orderKey"), 16); writeUnsigned(data, 19, checkedUnsigned(actionNonce, 64, "actionNonce"), 8); const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas); }
export function cancelAll(accounts: SessionAuthorizedAccounts, seatIndex: number, maxCancellations: number, actionNonce: bigint | number = 0): TransactionInstruction { if (!accounts.session && actionNonce !== 0) throw new RangeError("Main-wallet actions must use actionNonce zero"); const data = new Uint8Array(12); data[0] = OPCODE.cancelAll; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); data[3] = Number(checkedUnsigned(maxCancellations, 8, "maxCancellations")); writeUnsigned(data, 4, checkedUnsigned(actionNonce, 64, "actionNonce"), 8); const metas = [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]; if (accounts.session) metas.push(accountMeta(accounts.session, false, true)); return instruction(data, metas); }
export function updateFunding(accounts: InstructionAccounts, accumulator: bigint, timestamp: bigint | number): TransactionInstruction { const data = new Uint8Array(25); data[0] = OPCODE.updateFunding; writeSigned(data, 1, checkedSigned(accumulator, 128, "accumulator"), 16); writeUnsigned(data, 17, checkedUnsigned(timestamp, 64, "timestamp"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
export function liquidate(accounts: InstructionAccounts, seatIndex: number, maxQuantity: bigint | number): TransactionInstruction { const data = new Uint8Array(11); data[0] = OPCODE.liquidate; writeUnsigned(data, 1, checkedUnsigned(seatIndex, 16, "seatIndex"), 2); writeUnsigned(data, 3, checkedUnsigned(maxQuantity, 64, "maxQuantity"), 8); return instruction(data, [accountMeta(accounts.market, false, true), accountMeta(accounts.authority, true, false)]); }
