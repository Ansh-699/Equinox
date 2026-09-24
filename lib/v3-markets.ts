import deployment from "@/config/stockstream-deployment.json";

/** A live V3 market (deployment manifest `markets`): TSLA-PERP priced by Pyth,
 * pre-IPO perps priced by the market-maker service's PreStocks reporter. */
export interface V3Market {
  symbol: string;
  name: string;
  kind: "equity" | "pre-ipo" | "launch";
  core: string;
  oracleSnapshot: string;
  lookupTable: string;
  /** Pyth; a PreStocks token; or a graduated Meteora launch priced from its DAMM v2 `pool` per `lot` tokens. */
  oracle: { kind: "pyth" | "prestocks" | "meteora"; symbol?: string; token?: string; mint?: string; pool?: string; lot?: number; feedId: number };
}

export const V3_MARKETS = (deployment as unknown as { markets: V3Market[] }).markets;
export const PRIMARY_MARKET = V3_MARKETS[0];
export const v3MarketFor = (symbol: string): V3Market => V3_MARKETS.find((market) => market.symbol === symbol) ?? PRIMARY_MARKET;
/** Priced by our reporter (PreStocks, or a Meteora pool): no Pyth feed exists for them. */
export const isReporterPriced = (market: V3Market) => market.oracle.kind !== "pyth";
/** The market-maker service: live transactions, and candles for reporter-priced markets. */
export const MM_SERVICE_URL = (process.env.NEXT_PUBLIC_MM_STATUS_URL ?? "").replace(/\/v1\/mm\/status$/, "");
