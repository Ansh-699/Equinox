import { PublicKey } from "@solana/web3.js";
import { STOCKSTREAM_PROGRAM_KEY } from "../clients/stockstream/src";

export type MarketSessionPolicy = "regular" | "extended" | "close-only";
export interface StockInstrument {
  id: string;
  symbol: string;
  displayName: string;
  oracleFeedId?: string;
  marketSession: MarketSessionPolicy;
  live: boolean;
}
export interface PerpMarketConfig extends StockInstrument {
  instrumentPda: string;
  marketPda: string;
  vaultPda: string;
  scratchPda(seatIndex: number): string;
  maximumLeverage: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
}

function seedId(symbol: string): Uint8Array {
  const ids: Record<string, string> = {
    AAPL: "8b8f4b0e7f1a0d293e0f4a4f8e6f57c9d8e0b9af8b9e1c6d7a3f2e1d0c9b8a7f",
    TSLA: "5f3c8a1d9e7b6c2a4d0f1e8b7c6a5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c",
    NVDA: "2a6d9c4e8f1b3a7d5c0e2f4b6a8d1c3e5f7b9d0a2c4e6f8b1d3a5c7e9f0b2d4e",
  };
  const hex = ids[symbol] ?? (symbol.length === 64 && /^[0-9a-f]+$/i.test(symbol) ? symbol : undefined);
  if (!hex) throw new Error(`Missing instrument fixture: ${symbol}`);
  return Uint8Array.from(hex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
}

export function deriveInstrumentPda(instrumentId: string, program = STOCKSTREAM_PROGRAM_KEY): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("instrument"), Buffer.from(seedId(instrumentId))], program)[0];
}
export function derivePerpMarketPda(instrumentPda: PublicKey, program = STOCKSTREAM_PROGRAM_KEY): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("perp-market"), instrumentPda.toBuffer()], program)[0];
}
export function deriveVaultPda(market: PublicKey, program = STOCKSTREAM_PROGRAM_KEY): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], program)[0];
}
export function deriveScratchPda(market: PublicKey, seatIndex: number, program = STOCKSTREAM_PROGRAM_KEY): PublicKey {
  const seat = Buffer.alloc(2); seat.writeUInt16LE(seatIndex);
  return PublicKey.findProgramAddressSync([Buffer.from("settlement"), market.toBuffer(), seat], program)[0];
}

const fixture = (symbol: string, displayName: string, session: MarketSessionPolicy): PerpMarketConfig => {
  const id = Buffer.from(seedId(symbol)).toString("hex");
  const instrument = deriveInstrumentPda(id);
  const market = derivePerpMarketPda(instrument);
  return {
    id, symbol: `${symbol}-PERP`, displayName, oracleFeedId: `unverified-${symbol.toLowerCase()}`, marketSession: session, live: false,
    instrumentPda: instrument.toBase58(), marketPda: market.toBase58(), vaultPda: deriveVaultPda(market).toBase58(),
    scratchPda: (seatIndex) => deriveScratchPda(market, seatIndex).toBase58(),
    maximumLeverage: 5, initialMarginBps: 2_000, maintenanceMarginBps: 1_000,
  };
};

export const STOCK_INSTRUMENTS: readonly StockInstrument[] = [
  { ...fixture("AAPL", "Apple", "regular") },
  { ...fixture("TSLA", "Tesla", "extended") },
  { ...fixture("NVDA", "NVIDIA", "extended") },
];
export const PERP_MARKETS = STOCK_INSTRUMENTS as readonly PerpMarketConfig[];
export const MARKET_BY_SYMBOL = new Map(PERP_MARKETS.map((market) => [market.symbol, market]));
export function marketForSymbol(symbol: string): PerpMarketConfig {
  const market = MARKET_BY_SYMBOL.get(symbol.toUpperCase());
  if (!market) throw new Error(`Unknown StockStream market: ${symbol}`);
  return market;
}
