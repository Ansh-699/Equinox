export const STOCKSTREAM_PROGRAM_ID = "Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ";

// Compatibility export for the public client facade. The ABI module is the
// only opcode authority, so this cannot silently drift from generated parity.
export { OPCODE as STOCKSTREAM_INSTRUCTION } from "./abi/instructions";

export const STOCKSTREAM_ACCOUNT_SIZE = 222_752;
export const STOCKSTREAM_TRADING_SESSION_SIZE = 256;
export const STOCKSTREAM_PROGRAM_ID_BYTES = 32;
