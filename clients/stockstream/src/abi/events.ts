/**
 * Event discriminants and layout. Must match `events::EventKind` and
 * `events::encode_event` in the Rust program.
 */
/** `EventHeader` (`discriminator: u16, abi_version: u8, reserved: u8,
 * sequence: u64, market: [u8; 32], timestamp: u64`) is 52 bytes, not 12 --
 * this was wrong until the ABI parity generator was fixed to read the
 * real Rust struct size instead of copying the previously-committed
 * manifest back onto itself (its own "parity" test only ever checked the
 * summed EVENT_SIZE, which 12+88 and 52+48 both equal 100, so the wrong
 * split silently passed). */
export const EVENT_HEADER_SIZE = 52;
export const EVENT_PAYLOAD_SIZE = 48;
export const EVENT_SIZE = EVENT_HEADER_SIZE + EVENT_PAYLOAD_SIZE;

export const EVENT_KIND = {
  ExchangeInitialized: 100, ExchangeConfigUpdated: 101, StockInstrumentRegistered: 102,
  StockInstrumentUpdated: 103, StockInstrumentSuspended: 104, PerpMarketCreated: 105,
  MarketRiskUpdated: 106, MarketPaused: 107, MarketResumed: 108, MarketCloseOnly: 109,
  CorporateActionEntered: 110, CorporateActionResolved: 111, MarketClosed: 112,
  TraderSeatCreated: 200, TraderSeatClosed: 201, OrderPlaced: 202,
  OrderPartiallyFilled: 203, OrderFilled: 204, OrderCancelled: 205,
  CancelAllProgress: 206, OrderReplaced: 207, OrderExpired: 208,
  InvalidOrderRemoved: 209, SelfTradePrevented: 210,
  PositionChanged: 300, MarginChanged: 301, FundingAccumulatorUpdated: 302,
  FundingSettled: 303, LiquidationStarted: 304, PositionLiquidated: 305,
  BankruptcyRecorded: 306, InsuranceApplied: 307,
  VaultInitialized: 400, CollateralDeposited: 401, CollateralWithdrawn: 402,
  ProtocolFeesChanged: 403, InsuranceFundChanged: 404, BadDebtRecorded: 405,
  BadDebtResolved: 406, VaultSurplusDetected: 407, VaultDeficitDetected: 408,
  VaultReconciled: 409,
  OracleUpdated: 500, OracleRejected: 501, MarketSessionChanged: 502,
  TradingStatusChanged: 503, OracleStale: 504, OracleRecovered: 505,
  DelegationRequested: 600, MarketDelegated: 601, CommitRequested: 602,
  CommitSequenceChanged: 603, UndelegationRequested: 604, RestorationPending: 605,
  MarketRestored: 606, DelegationErrorState: 607,
  TradingSessionAuthorized: 700, TradingSessionLimitsUpdated: 701,
  TradingSessionActionConsumed: 702, TradingSessionRevoked: 703, TradingSessionClosed: 704,
} as const;

export const EVENT_KIND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(EVENT_KIND).map(([k, v]) => [v, k]),
);
