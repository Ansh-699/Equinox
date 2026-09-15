export const STOCKSTREAM_PROGRAM_ID = "6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU";

export const STOCKSTREAM_INSTRUCTION = {
  initializeMarket: 0,
  createTraderSeat: 1,
  closeTraderSeat: 2,
  placeOrder: 3,
  cancelOrder: 4,
  cancelAll: 5,
  updateFunding: 6,
  liquidate: 7,
  initializeSettlementScratch: 8,
  initializeVault: 9,
  depositCollateral: 10,
  withdrawCollateral: 11,
  consumeOracleUpdate: 12,
  delegateMarket: 13,
  commitMarket: 14,
  commitAndUndelegate: 15,
  undelegationCallback: 16,
  authorizeTradingSession: 17,
  revokeTradingSession: 18,
} as const;

export const STOCKSTREAM_ACCOUNT_SIZE = 222_752;
export const STOCKSTREAM_PROGRAM_ID_BYTES = 32;
