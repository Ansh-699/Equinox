/**
 * Oracle field offsets and enums. Must match the Rust program's
 * `MarketStateHeader` layout.
 */


export const MARKET_SESSION = { Regular: 0, PreMarket: 1, PostMarket: 2, OverNight: 3, Closed: 4 } as const;

/** Pyth Pro's `marketSession` field maps to `MarketMode` on-chain. */
export const SESSION_TO_MODE: Record<number, number> = {
  0: 1, // Regular -> Open
  1: 1, // PreMarket -> Open
  2: 1, // PostMarket -> Open
  3: 2, // OverNight -> CloseOnly
  4: 2, // Closed -> CloseOnly
};
