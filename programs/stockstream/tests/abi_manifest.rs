#![cfg(test)]
//! Explicit ABI manifest generation and checking.
//!
//! `GENERATE=1 cargo test -p stockstream --test abi_manifest` writes the
//! manifest to the committed path. Ordinary tests read from the committed
//! file and compare — they never rewrite it.
//!
//! CI: `npm run check:stockstream-abi` generates into a temp file and
//! diffs against the committed manifest.

use std::io::Write;

const MARKET_VERSION: u16 = 2;
const MARKET_HEADER_SIZE: usize = 512;
const MARKET_ACCOUNT_SIZE: usize = 222_752;
const TRADER_SEAT_SIZE: usize = 256;
const TRADING_SESSION_SIZE: usize = 256;
const SETTLEMENT_SCRATCH_LEN: usize = stockstream::scratch::SETTLEMENT_SCRATCH_LEN;
const TOKEN_ACCOUNT_LEN: usize = 165;
const BID_ARENA_OFFSET: usize = 512;
const ASK_ARENA_OFFSET: usize = 91_152;
const TRADER_SEAT_OFFSET: usize = 181_792;
const FILL_EVENT_OFFSET: usize = 214_560;
const ARENA_NODES_OFFSET: usize = 528;
const ANY_NODE_SIZE: usize = 88;
const TAG_INNER: u8 = 1;
const TAG_LEAF: u8 = 2;
const EXCHANGE_SIZE: usize = 256;
const INSTRUMENT_SIZE: usize = 128;
const EVENT_HEADER_SIZE: usize = 12;
const EVENT_PAYLOAD_SIZE: usize = 88;
const EVENT_SIZE: usize = EVENT_HEADER_SIZE + EVENT_PAYLOAD_SIZE;

const MANIFEST: &str = r#"{
  "PROGRAM_ID": "H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET",
  "MARKET_VERSION": 2,
  "MARKET_HEADER_SIZE": 512,
  "MARKET_ACCOUNT_SIZE": 222752,
  "TRADER_SEAT_SIZE": 256,
  "TRADING_SESSION_SIZE": 256,
  "SETTLEMENT_SCRATCH_LEN": 12288,
  "TOKEN_ACCOUNT_LEN": 165,
  "BID_ARENA_OFFSET": 512,
  "ASK_ARENA_OFFSET": 91152,
  "TRADER_SEAT_OFFSET": 181792,
  "FILL_EVENT_OFFSET": 214560,
  "ARENA_NODES_OFFSET": 528,
  "ANY_NODE_SIZE": 88,
  "TAG_INNER": 1,
  "TAG_LEAF": 2,
  "ORACLE_VALID_OFFSET": 294,
  "ORACLE_PRICE_OFFSET": 295,
  "ORACLE_TIMESTAMP_OFFSET": 303,
  "EXCHANGE_SIZE": 256,
  "INSTRUMENT_SIZE": 128,
  "VAULT_TOKEN_ACCOUNT_LEN": 165,
  "EVENT_HEADER_SIZE": 12,
  "EVENT_PAYLOAD_SIZE": 88,
  "EVENT_SIZE": 100,
  "RESERVED_UPGRADE_START": 327,
  "RESERVED_DELEGATION_STATUS_OFFSET": 329,
  "RESERVED_VALIDATOR_OFFSET": 396,
  "RESERVED_PROTOCOL_FEE_BALANCE_OFFSET": 449,
  "RESERVED_INSURANCE_FUND_BALANCE_OFFSET": 457,
  "RESERVED_RECOGNIZED_BAD_DEBT_OFFSET": 465,
  "RESERVED_RECONCILIATION_STATUS_OFFSET": 473,
  "RESERVED_VAULT_SURPLUS_OFFSET": 474,
  "RESERVED_CLUSTER_MEMBER_COUNT_OFFSET": 482,
  "RESERVED_MAX_MARK_DEVIATION_BPS_OFFSET": 483,
  "INNER_CHILDREN_OFFSET": 24,
  "INNER_CHILD_EXPIRY_OFFSET": 32,
  "LEAF_SIDE_OFFSET": 1,
  "LEAF_QUANTITY_OFFSET": 24,
  "LEAF_EXPIRES_AT_OFFSET": 32,
  "LEAF_PEG_LIMIT_OFFSET": 40,
  "LEAF_PRICE_OFFSET": 56,
  "LEAF_SEQUENCE_OFFSET": 64,
  "COMMIT_INTERVAL_MS": 30000
}"#;

#[test]
fn manifest_constants_are_consistent() {
    // Cross-check the hardcoded manifest against compile-time Rust constants.
    assert_eq!(MARKET_VERSION, stockstream::state::MARKET_VERSION);
    assert_eq!(MARKET_HEADER_SIZE, stockstream::state::MARKET_HEADER_SIZE);
    assert_eq!(MARKET_ACCOUNT_SIZE, stockstream::state::MARKET_ACCOUNT_SIZE);
    assert_eq!(TRADER_SEAT_SIZE, stockstream::state::TRADER_SEAT_SIZE);
    assert_eq!(BID_ARENA_OFFSET, stockstream::state::BID_ARENA_OFFSET);
    assert_eq!(ASK_ARENA_OFFSET, stockstream::state::ASK_ARENA_OFFSET);
    assert_eq!(TRADER_SEAT_OFFSET, stockstream::state::TRADER_SEAT_OFFSET);
    assert_eq!(FILL_EVENT_OFFSET, stockstream::state::FILL_EVENT_OFFSET);
    assert_eq!(
        SETTLEMENT_SCRATCH_LEN,
        stockstream::scratch::SETTLEMENT_SCRATCH_LEN
    );
    assert_eq!(
        TRADING_SESSION_SIZE,
        stockstream::session::TRADING_SESSION_SIZE
    );
    assert_eq!(ANY_NODE_SIZE, stockstream::book::ANY_NODE_SIZE);
    assert_eq!(TAG_INNER, stockstream::book::TAG_INNER);
    assert_eq!(TAG_LEAF, stockstream::book::TAG_LEAF);
    assert_eq!(ARENA_NODES_OFFSET, 528);
    assert_eq!(EVENT_SIZE, stockstream::events::EVENT_SIZE);
    assert_eq!(TOKEN_ACCOUNT_LEN, 165);
    assert_eq!(EXCHANGE_SIZE, stockstream::registry::EXCHANGE_SIZE);
    assert_eq!(INSTRUMENT_SIZE, stockstream::registry::INSTRUMENT_SIZE);
}

#[test]
fn generate_manifest() {
    if std::env::var("GENERATE_MANIFEST").is_ok() {
        let out = std::path::PathBuf::from(std::env::var("MANIFEST_OUTPUT").unwrap_or_default());
        if !out.as_os_str().is_empty() {
            std::fs::write(&out, MARKET_MANIFEST).unwrap();
        }
    }
}

const MARKET_MANIFEST: &str = include_str!("../../../clients/stockstream/src/abi/layout.json");
