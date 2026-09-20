import { EVENT_HEADER_SIZE, EVENT_KIND_NAMES, EVENT_SIZE } from "./events";

export interface StockStreamEvent { discriminator: number; kind: string; abiVersion: number; sequence: bigint; market: string; timestamp: bigint; payload: Uint8Array; }
export function decodeStockStreamEvent(logLine: string): StockStreamEvent | null {
  const prefix = "Program data: "; if (!logLine.startsWith(prefix)) return null; let bytes: Buffer;
  try { bytes = Buffer.from(logLine.slice(prefix.length).trim(), "base64"); } catch { return null; }
  if (bytes.length !== EVENT_SIZE) return null; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const discriminator = view.getUint16(0, true);
  return { discriminator, kind: EVENT_KIND_NAMES[discriminator] ?? `Unknown(${discriminator})`, abiVersion: bytes[2], sequence: view.getBigUint64(4, true), market: Buffer.from(bytes.subarray(12, 44)).toString("hex"), timestamp: view.getBigUint64(44, true), payload: bytes.subarray(EVENT_HEADER_SIZE, EVENT_SIZE) };
}
function payloadView(payload: Uint8Array): DataView { return new DataView(payload.buffer, payload.byteOffset, payload.byteLength); }
export function decodeSeatPayload(payload: Uint8Array) { return { seatIndex: payloadView(payload).getUint16(0, true) }; }
export function decodeSeatAmountPayload(payload: Uint8Array) { const view = payloadView(payload); return { seatIndex: view.getUint16(0, true), amount: view.getBigUint64(2, true), balance: view.getBigUint64(10, true) }; }
export function decodeOrderPayload(payload: Uint8Array) { const view = payloadView(payload); return { seatIndex: view.getUint16(0, true), orderKey: (() => { let v = 0n; for (let i = 15; i >= 0; i -= 1) v = (v << 8n) | BigInt(payload[2 + i]); return v; })(), side: payload[18], price: view.getBigInt64(19, true), quantity: view.getBigUint64(27, true) }; }
export function decodeFillPayload(payload: Uint8Array) { const view = payloadView(payload); return { makerSeat: view.getUint32(0, true), takerSeat: view.getUint32(4, true), price: view.getBigInt64(8, true), quantity: view.getBigUint64(16, true), fillSequence: view.getBigUint64(24, true) }; }
function readI128(payload: Uint8Array, offset: number): bigint { let value = 0n; for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(payload[offset + i]); const signBit = 1n << 127n; return value >= signBit ? value - (signBit << 1n) : value; }
export function decodePositionPayload(payload: Uint8Array) { return { seatIndex: payloadView(payload).getUint16(0, true), basePosition: readI128(payload, 2), quoteEntryValue: readI128(payload, 18) }; }
export function decodeFundingPayload(payload: Uint8Array) { return { seatIndex: payloadView(payload).getUint16(0, true), accumulator: readI128(payload, 2), payment: readI128(payload, 18) }; }
export function decodeLiquidationPayload(payload: Uint8Array) { const view = payloadView(payload); return { seatIndex: view.getUint16(0, true), quantity: view.getBigUint64(2, true), price: view.getBigInt64(10, true) }; }
export function decodeOraclePayload(payload: Uint8Array) { const view = payloadView(payload); return { price: view.getBigInt64(0, true), exponent: view.getInt16(8, true), confidence: view.getBigInt64(10, true), session: view.getInt16(18, true) }; }
export function decodeDelegationPayload(payload: Uint8Array) { return { validator: Buffer.from(payload.subarray(0, 32)).toString("hex"), sequence: payloadView(payload).getBigUint64(32, true) }; }
export function decodeSessionPayload(payload: Uint8Array) { const view = payloadView(payload); return { seatIndex: view.getUint16(0, true), sessionSigner: Buffer.from(payload.subarray(2, 34)).toString("hex"), nonce: view.getBigUint64(34, true) }; }
export function decodeRegistryPayload(payload: Uint8Array) { return { instrumentId: Buffer.from(payload.subarray(0, 32)).toString("hex") }; }
export function decodeReconciliationPayload(payload: Uint8Array) { const view = payloadView(payload); return { actual: view.getBigUint64(0, true), expected: view.getBigUint64(8, true), status: payload[16] }; }
