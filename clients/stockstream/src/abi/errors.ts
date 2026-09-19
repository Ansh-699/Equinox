/**
 * Canonical error-code → name mapping. Must match `error::StockStreamError`.
 */
export const ERROR_CODES: Record<number, string> = {
  0x6001: "InvalidMarketLayout", 0x6002: "MarketNotInitialized", 0x6003: "MarketAlreadyInitialized",
  0x6004: "InvalidSeat", 0x6005: "InvalidInstruction", 0x6006: "SeatOccupied",
  0x6007: "SeatNotFound", 0x6008: "MarketNotWritable", 0x6009: "SeatNotEmpty",
  0x600a: "RiskViolation", 0x600b: "ArithmeticOverflow", 0x600c: "UnsupportedInProduction",
  0x600d: "InvalidSettlementScratch", 0x600e: "MagicBlockInvalidAccount",
  0x600f: "MagicBlockAlreadyDelegated", 0x6010: "MagicBlockNotDelegated",
  0x6011: "MagicBlockSequenceReplay", 0x6012: "MagicBlockInvalidCallback",
  0x6013: "MagicBlockScratchNotEmpty", 0x6014: "MagicBlockUndelegationInProgress",
  0x6015: "MagicBlockCallbackAlreadyConsumed", 0x6016: "InvalidTradingSession",
  0x6017: "SessionNonceReplay", 0x6018: "CustodyViolation",
  0x6019: "SelfTradeAborted", 0x601a: "MagicBlockClusterTooLarge",
  0x601b: "OracleUnavailable",
};

export function errorName(code: number): string { return ERROR_CODES[code] ?? `Unknown(0x${code.toString(16)})`; }
