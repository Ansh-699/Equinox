/**
 * Canonical StockStream ABI constants.
 *
 * Generated from `programs/stockstream/src/` by `tests/abi_manifest.rs`.
 * CI parity test (`npm run check:stockstream-abi`) fails if Rust changes
 * without regenerating this manifest.
 *
 * The Rust program is authoritative for every offset and size here.
 */
export const PROGRAM_ID = "H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET";
export const MARKET_VERSION = 2;
export const MARKET_HEADER_SIZE = 512;
export const MARKET_ACCOUNT_SIZE = 222_752;
export const TRADER_SEAT_SIZE = 256;
export const TRADING_SESSION_SIZE = 256;
/** The real, computed (`align_up`-derived) settlement-scratch account
 * size -- NOT the 12,288-byte upper bound `scratch.rs` asserts it stays
 * under at compile time. This was wrong (hardcoded as the cap) until the
 * ABI parity generator was fixed to read the real Rust constant instead
 * of copying the previously-committed manifest back onto itself. */
export const SETTLEMENT_SCRATCH_LEN = 2_992;
export const TOKEN_ACCOUNT_LEN = 165;

export const BID_ARENA_OFFSET = 512;
export const ASK_ARENA_OFFSET = 91_152;
export const TRADER_SEAT_OFFSET = 181_792;
export const FILL_EVENT_OFFSET = 214_560;

export const ARENA_NODES_OFFSET = 528;
export const ANY_NODE_SIZE = 88;
export const TAG_INNER = 1;
export const TAG_LEAF = 2;

export const RESERVED_UPGRADE_OFFSET = 327;
/** `reserved_upgrade[2]` = DelegationStatus (0=NotDelegated 1=Delegated 2=Undelegating 3=Restored) */
export const RESERVED_DELEGATION_STATUS = 327 + 2;
/** `reserved_upgrade[69..101]` = validator pubkey (32 bytes) */
export const RESERVED_VALIDATOR = 327 + 69;
/** `reserved_upgrade[122..130]` = protocol fee balance (u64 LE) */
export const RESERVED_PROTOCOL_FEE_BALANCE = 327 + 122;
/** `reserved_upgrade[130..138]` = insurance fund balance */
export const RESERVED_INSURANCE_FUND_BALANCE = 327 + 130;
/** `reserved_upgrade[138..146]` = recognized bad debt */
export const RESERVED_RECOGNIZED_BAD_DEBT = 327 + 138;
/** `reserved_upgrade[146]` = reconciliation status */
export const RESERVED_RECONCILIATION_STATUS = 327 + 146;
/** `reserved_upgrade[147..155]` = vault surplus */
export const RESERVED_VAULT_SURPLUS = 327 + 147;
/** `reserved_upgrade[155]` = cluster member count */
export const RESERVED_CLUSTER_MEMBER_COUNT = 327 + 155;
/** `reserved_upgrade[156..158]` = max mark deviation bps (i16 LE) */
export const RESERVED_MAX_MARK_DEVIATION_BPS = 327 + 156;

export const ORACLE_VALID_OFFSET = 294;
export const ORACLE_PRICE_OFFSET = 295;
export const ORACLE_TIMESTAMP_OFFSET = 303;

export const EXCHANGE_SIZE = 256;
export const INSTRUMENT_SIZE = 128;
export const VAULT_TOKEN_ACCOUNT_LEN = 165;

export const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const MAGIC_PROGRAM = "Magic11111111111111111111111111111111111111";
export const MAGIC_CONTEXT = "MagicContext1111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const VALIDATOR = "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57";

export const COMMIT_INTERVAL_MS = 30_000;

/** SPL Token `initializeAccount3` opcode */
export const SPL_INIT_ACCOUNT3 = 18;
/** SPL Token `mintTo` opcode */
export const SPL_MINT_TO = 7;
export const SPL_TRANSFER = 3;

export const TRADING_SESSION_SEED = "trading_session";
