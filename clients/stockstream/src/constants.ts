export const STOCKSTREAM_PROGRAM_ID = "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ";

// Compatibility export for the public client facade. The ABI module is the
// only opcode authority, so this cannot silently drift from generated parity.
export { OPCODE as STOCKSTREAM_INSTRUCTION } from "./abi/instructions";

export const STOCKSTREAM_ACCOUNT_SIZE = 222_752;
export const STOCKSTREAM_TRADING_SESSION_SIZE = 256;
export const STOCKSTREAM_PROGRAM_ID_BYTES = 32;
