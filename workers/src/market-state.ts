import { getBase58Decoder } from "@solana/kit";
import type { MagicRouterTransport, SolanaL1Transport } from "./chain-transports";

/**
 * Decodes the authoritative on-chain `MarketStateHeader` -- the single
 * source of truth every keeper input source in this module must defer to
 * over any D1/Worker projection (Priority 8, Section 4: "never let a stale
 * Worker projection override onchain"). This is a second, independent
 * decoder from `clients/stockstream/src::decodeMarketState`, not a reuse of
 * it: that module depends on `@solana/web3.js`, which is not (and should
 * not become) a `workers/` dependency now that `workers/` uses
 * `@solana/kit` -- the same reasoning `private-sessions.ts`'s
 * `decodeTraderSeatProjection` already applied to `TraderSeat`. Field
 * offsets are cross-checked against
 * `programs/stockstream/tests/account_settlement.rs::worker_market_state_reader_offsets_match_the_rust_header_layout`
 * via `core::mem::offset_of!` (the header is `#[repr(C, packed(1))]`, so
 * hand-counted contiguous offsets are safe here -- unlike `TraderSeat`,
 * which is `packed(8)`).
 */

export const MARKET_DISCRIMINATOR = "STKMRK01";
export const MARKET_VERSION = 2;
export const MARKET_HEADER_SIZE = 512;
export const MARKET_ACCOUNT_SIZE = 512 + 90_640 + 90_640 + 128 * 256 + 64 * 128;

export const MarketMode = { Paused: 0, Open: 1, CloseOnly: 2, Emergency: 3 } as const;

const HEADER_FIELD_OFFSETS = {
  discriminator: 0,
  version: 8,
  initialized: 10,
  mode: 11,
  marketAuthority: 12,
  pauseAuthority: 44,
  emergencyAuthority: 76,
  collateralMint: 108,
  maintenanceMarginBps: 194,
  makerFeeBps: 198,
  takerFeeBps: 200,
  maximumLeverage: 202,
  currentOpenInterest: 238,
  globalOrderSequence: 254,
  globalEventSequence: 262,
  fundingAccumulator: 270,
  lastFundingTimestamp: 286,
  oracleValid: 294,
  lastVerifiedOraclePrice: 295,
  lastVerifiedOracleTimestamp: 303,
} as const;

export interface MarketState {
  mode: number;
  marketAuthority: string;
  emergencyAuthority: string;
  maintenanceMarginBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  maximumLeverage: number;
  currentOpenInterest: bigint;
  globalOrderSequence: bigint;
  globalEventSequence: bigint;
  fundingAccumulator: bigint;
  lastFundingTimestamp: bigint;
  oracleValid: boolean;
  lastVerifiedOraclePrice: bigint;
  lastVerifiedOracleTimestamp: bigint;
}

const base58 = getBase58Decoder();

function readI128(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  const signBit = 1n << 127n;
  return value >= signBit ? value - (signBit << 1n) : value;
}

/** Decodes and validates the header; returns `null` on any mismatch
 * (wrong discriminator, wrong version, too short) rather than throwing --
 * callers skip the market for money/risk-changing work instead of
 * aborting every other market in the same tick. */
export function decodeMarketHeader(bytes: Uint8Array): MarketState | null {
  if (bytes.length < MARKET_HEADER_SIZE) return null;
  const discriminator = new TextDecoder().decode(bytes.slice(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (discriminator !== MARKET_DISCRIMINATOR || view.getUint16(HEADER_FIELD_OFFSETS.version, true) !== MARKET_VERSION) return null;
  if (view.getUint8(HEADER_FIELD_OFFSETS.initialized) !== 1) return null;
  return {
    mode: view.getUint8(HEADER_FIELD_OFFSETS.mode),
    marketAuthority: base58.decode(bytes.slice(HEADER_FIELD_OFFSETS.marketAuthority, HEADER_FIELD_OFFSETS.marketAuthority + 32)),
    emergencyAuthority: base58.decode(bytes.slice(HEADER_FIELD_OFFSETS.emergencyAuthority, HEADER_FIELD_OFFSETS.emergencyAuthority + 32)),
    maintenanceMarginBps: view.getUint16(HEADER_FIELD_OFFSETS.maintenanceMarginBps, true),
    makerFeeBps: view.getUint16(HEADER_FIELD_OFFSETS.makerFeeBps, true),
    takerFeeBps: view.getUint16(HEADER_FIELD_OFFSETS.takerFeeBps, true),
    maximumLeverage: view.getUint32(HEADER_FIELD_OFFSETS.maximumLeverage, true),
    currentOpenInterest: readI128(bytes, HEADER_FIELD_OFFSETS.currentOpenInterest),
    globalOrderSequence: view.getBigUint64(HEADER_FIELD_OFFSETS.globalOrderSequence, true),
    globalEventSequence: view.getBigUint64(HEADER_FIELD_OFFSETS.globalEventSequence, true),
    fundingAccumulator: readI128(bytes, HEADER_FIELD_OFFSETS.fundingAccumulator),
    lastFundingTimestamp: view.getBigUint64(HEADER_FIELD_OFFSETS.lastFundingTimestamp, true),
    oracleValid: view.getUint8(HEADER_FIELD_OFFSETS.oracleValid) === 1,
    lastVerifiedOraclePrice: view.getBigInt64(HEADER_FIELD_OFFSETS.lastVerifiedOraclePrice, true),
    lastVerifiedOracleTimestamp: view.getBigUint64(HEADER_FIELD_OFFSETS.lastVerifiedOracleTimestamp, true),
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fetches one market account's raw bytes through the given transport (L1
 * or ER -- the caller decides the domain). `null` for a missing account.
 * Callers needing both the header and a seat (e.g. the liquidation
 * scanner) should use this once and decode both from the same bytes,
 * rather than fetching the account twice. */
export async function fetchAuthoritativeMarketAccountBytes(
  transport: SolanaL1Transport | MagicRouterTransport,
  marketPda: string,
): Promise<Uint8Array | null> {
  const result = await transport.multipleAccounts([marketPda]);
  const account = result.value[0];
  if (!account || account.data === null) return null;
  return base64ToBytes(account.data[0]);
}

/** Fetches one market account and decodes its header. `null` for a missing
 * account, an account too short to hold a header, or a header that fails
 * `decodeMarketHeader`'s own checks. */
export async function fetchAuthoritativeMarketState(
  transport: SolanaL1Transport | MagicRouterTransport,
  marketPda: string,
): Promise<MarketState | null> {
  const bytes = await fetchAuthoritativeMarketAccountBytes(transport, marketPda);
  return bytes ? decodeMarketHeader(bytes) : null;
}
