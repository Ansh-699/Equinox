export const STOCKSTREAM_PROGRAM_ID = "6QyZWQw7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU";

export const STOCKSTREAM_INSTRUCTION = {
  initializeMarket: 0,
  createTraderSeat: 1,
  closeTraderSeat: 2,
  placeOrder: 3,
  cancelOrder: 4,
  cancelAll: 5,
  updateFunding: 6,
  liquidate: 7,
} as const;

export const STOCKSTREAM_ACCOUNT_SIZE = 222_752;
export const STOCKSTREAM_PROGRAM_ID_BYTES = 32;
