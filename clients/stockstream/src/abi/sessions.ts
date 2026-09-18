import { PublicKey } from "@solana/web3.js";

/**
 * TradingSession layout and action bits. Must match `session.rs`.
 */
export const TRADING_SESSION_DISCRIMINATOR = "STKSES02";
export const TRADING_SESSION_VERSION = 1;
export const TRADING_SESSION_SEED = "trading_session";

export const SESSION_ACTION = {
  place: 1 << 0, cancel: 1 << 1, cancelAll: 1 << 2,
  replace: 1 << 3, reduceOnlyClose: 1 << 4,
  all: (1 << 5) - 1,
} as const;

export interface TradingSessionView {
  discriminator: string; version: number; initialized: boolean; revoked: boolean;
  owner: string; sessionSigner: string; targetProgram: string; market: string;
  traderSeatIndex: number; createdAt: bigint; expiresAt: bigint;
  actions: number; maxOrderNotional: bigint; maxCumulativeNotional: bigint;
  consumedCumulativeNotional: bigint; maximumExposure: bigint;
  maximumOpenOrders: number; nextExpectedNonce: bigint;
  lastActionTimestamp: bigint; sessionGeneration: number;
}

export function decodeTradingSession(bytes: Uint8Array): TradingSessionView | null {
  if (bytes.length !== 256) return null;
  const discriminator = new TextDecoder().decode(bytes.subarray(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (discriminator !== "STKSES02" || view.getUint16(8, true) !== 1) return null;
  return {
    discriminator, version: view.getUint16(8, true),
    initialized: view.getUint8(10) === 1,
    revoked: bytes[11] !== 0,
    owner: new PublicKey(bytes.subarray(12, 44)).toBase58(),
    sessionSigner: new PublicKey(bytes.subarray(44, 76)).toBase58(),
    targetProgram: new PublicKey(bytes.subarray(76, 108)).toBase58(),
    market: new PublicKey(bytes.subarray(108, 140)).toBase58(),
    traderSeatIndex: view.getUint16(140, true),
    createdAt: view.getBigUint64(142, true),
    expiresAt: view.getBigUint64(150, true),
    actions: bytes[158],
    maxOrderNotional: view.getBigUint64(159, true),
    maxCumulativeNotional: view.getBigUint64(167, true),
    consumedCumulativeNotional: view.getBigUint64(175, true),
    maximumExposure: (() => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(bytes[183 + i]); const s = 1n << 127n; return v >= s ? v - (s << 1n) : v; })(),
    maximumOpenOrders: view.getUint16(199, true),
    nextExpectedNonce: view.getBigUint64(201, true),
    lastActionTimestamp: view.getBigUint64(209, true),
    sessionGeneration: view.getUint32(217, true),
  };
}
