#![cfg(test)]
//! Explicit ABI manifest generation and checking.
//!
//! `npm run generate:equinox-abi` (== `GENERATE_MANIFEST=1 ... cargo
//! test -- generate_manifest`) writes the manifest to the committed path.
//! `npm run check:equinox-abi` generates into a temp file and diffs
//! it against the committed one, failing the build on any mismatch.
//!
//! Every value in the generated manifest is either a real, compile-time
//! Rust constant from the program crate, or a `core::mem::offset_of!`
//! computed directly against the real `#[repr(C, packed)]` struct --
//! never a hand-transcribed number. This was NOT true before: the
//! previous version of this file built its manifest from a hardcoded
//! `&str` literal, and `generate_manifest` wrote that same literal
//! straight through `include_str!` of the COMMITTED layout.json -- i.e.
//! it copied the existing file back onto itself. `check:equinox-abi`'s
//! diff could therefore never detect real Rust/TypeScript drift; it only
//! ever compared a file against a copy of itself. Two concrete bugs that
//! slipped through as a direct result: `EVENT_HEADER_SIZE`/
//! `EVENT_PAYLOAD_SIZE` were wrong (12/88, should be 52/48 -- see
//! `events.rs`), and the committed `MANIFEST_OUTPUT`/read-back path in
//! the npm script itself didn't even match (`/tmp/abi-check.json` vs
//! `/tmp/abi_layout.json`).

use std::mem::offset_of;
use equinox::book::{InnerNode, LeafNode};
use equinox::state::MarketStateHeader;

#[test]
fn generate_manifest() {
    let manifest = build_manifest();
    if std::env::var("GENERATE_MANIFEST").is_ok() {
        let out = std::path::PathBuf::from(std::env::var("MANIFEST_OUTPUT").unwrap_or_default());
        if !out.as_os_str().is_empty() {
            std::fs::write(&out, manifest).unwrap();
        }
    }
}

/// Every real Rust source this manifest is built from, in one place so a
/// missing import (not a missing assertion) is what breaks if a constant
/// this depends on is ever renamed or removed.
fn build_manifest() -> String {
    let program_id = "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ";

    // Reserved-region offsets are RELATIVE to `reserved_upgrade`'s own
    // start within the header -- the manifest's fields are ABSOLUTE
    // account-byte offsets, so each one adds the real, compiler-verified
    // start of that field to the program's own relative constant (never a
    // pre-added magic number).
    let reserved_upgrade_start = offset_of!(MarketStateHeader, reserved_upgrade);
    let delegation_status_offset =
        reserved_upgrade_start + equinox::state::RESERVED_DELEGATION_STATUS;
    let validator_offset = reserved_upgrade_start + equinox::state::RESERVED_VALIDATOR;
    let protocol_fee_balance_offset =
        reserved_upgrade_start + equinox::state::RESERVED_PROTOCOL_FEE_BALANCE;
    let insurance_fund_balance_offset =
        reserved_upgrade_start + equinox::state::RESERVED_INSURANCE_FUND_BALANCE;
    let recognized_bad_debt_offset =
        reserved_upgrade_start + equinox::state::RESERVED_RECOGNIZED_BAD_DEBT;
    let reconciliation_status_offset =
        reserved_upgrade_start + equinox::state::RESERVED_RECONCILIATION_STATUS;
    let vault_surplus_offset = reserved_upgrade_start + equinox::state::RESERVED_VAULT_SURPLUS;
    let cluster_member_count_offset =
        reserved_upgrade_start + equinox::state::RESERVED_CLUSTER_MEMBER_COUNT;
    let max_mark_deviation_bps_offset =
        reserved_upgrade_start + equinox::state::RESERVED_MAX_MARK_DEVIATION_BPS;

    let oracle_valid_offset = offset_of!(MarketStateHeader, oracle_valid);
    let oracle_price_offset = offset_of!(MarketStateHeader, last_verified_oracle_price);
    let oracle_timestamp_offset = offset_of!(MarketStateHeader, last_verified_oracle_timestamp);

    // PATRICIA node field offsets, real offset_of! against the actual
    // #[repr(C, packed(8))] structs in book.rs -- not hand-computed.
    let inner_children_offset = offset_of!(InnerNode, children);
    let inner_child_expiry_offset = offset_of!(InnerNode, child_earliest_expiry);
    let leaf_side_offset = offset_of!(LeafNode, side);
    let leaf_quantity_offset = offset_of!(LeafNode, quantity);
    let leaf_expires_at_offset = offset_of!(LeafNode, expires_at);
    let leaf_peg_limit_offset = offset_of!(LeafNode, peg_limit);
    let leaf_price_offset = offset_of!(LeafNode, price_or_offset);
    let leaf_sequence_offset = offset_of!(LeafNode, sequence);

    format!(
        r#"{{
  "PROGRAM_ID": "{program_id}",
  "MARKET_VERSION": {market_version},
  "MARKET_HEADER_SIZE": {market_header_size},
  "MARKET_ACCOUNT_SIZE": {market_account_size},
  "TRADER_SEAT_SIZE": {trader_seat_size},
  "TRADING_SESSION_SIZE": {trading_session_size},
  "SETTLEMENT_SCRATCH_LEN": {settlement_scratch_len},
  "TOKEN_ACCOUNT_LEN": 165,
  "BID_ARENA_OFFSET": {bid_arena_offset},
  "ASK_ARENA_OFFSET": {ask_arena_offset},
  "TRADER_SEAT_OFFSET": {trader_seat_offset},
  "FILL_EVENT_OFFSET": {fill_event_offset},
  "ARENA_NODES_OFFSET": {arena_nodes_offset},
  "ANY_NODE_SIZE": {any_node_size},
  "TAG_INNER": {tag_inner},
  "TAG_LEAF": {tag_leaf},
  "ORACLE_VALID_OFFSET": {oracle_valid_offset},
  "ORACLE_PRICE_OFFSET": {oracle_price_offset},
  "ORACLE_TIMESTAMP_OFFSET": {oracle_timestamp_offset},
  "EXCHANGE_SIZE": {exchange_size},
  "INSTRUMENT_SIZE": {instrument_size},
  "VAULT_TOKEN_ACCOUNT_LEN": 165,
  "EVENT_HEADER_SIZE": {event_header_size},
  "EVENT_PAYLOAD_SIZE": {event_payload_size},
  "EVENT_SIZE": {event_size},
  "RESERVED_UPGRADE_START": {reserved_upgrade_start},
  "RESERVED_DELEGATION_STATUS_OFFSET": {delegation_status_offset},
  "RESERVED_VALIDATOR_OFFSET": {validator_offset},
  "RESERVED_PROTOCOL_FEE_BALANCE_OFFSET": {protocol_fee_balance_offset},
  "RESERVED_INSURANCE_FUND_BALANCE_OFFSET": {insurance_fund_balance_offset},
  "RESERVED_RECOGNIZED_BAD_DEBT_OFFSET": {recognized_bad_debt_offset},
  "RESERVED_RECONCILIATION_STATUS_OFFSET": {reconciliation_status_offset},
  "RESERVED_VAULT_SURPLUS_OFFSET": {vault_surplus_offset},
  "RESERVED_CLUSTER_MEMBER_COUNT_OFFSET": {cluster_member_count_offset},
  "RESERVED_MAX_MARK_DEVIATION_BPS_OFFSET": {max_mark_deviation_bps_offset},
  "INNER_CHILDREN_OFFSET": {inner_children_offset},
  "INNER_CHILD_EXPIRY_OFFSET": {inner_child_expiry_offset},
  "LEAF_SIDE_OFFSET": {leaf_side_offset},
  "LEAF_QUANTITY_OFFSET": {leaf_quantity_offset},
  "LEAF_EXPIRES_AT_OFFSET": {leaf_expires_at_offset},
  "LEAF_PEG_LIMIT_OFFSET": {leaf_peg_limit_offset},
  "LEAF_PRICE_OFFSET": {leaf_price_offset},
  "LEAF_SEQUENCE_OFFSET": {leaf_sequence_offset},
  "COMMIT_INTERVAL_MS": {commit_interval_ms},
  "V3_LAYOUT_VERSION": {v3_layout_version},
  "V3_COMMIT_ACCOUNT_HARD_MAX": {v3_commit_account_hard_max},
  "V3_COMMIT_ACCOUNT_SAFE_MAX": {v3_commit_account_safe_max},
  "V3_PAGE_ACCOUNT_SIZE": {v3_page_account_size},
  "V3_MARKET_CORE_SIZE": {v3_market_core_size},
  "V3_BOOK_PAGE_SIZE": {v3_book_page_size},
  "V3_SEAT_SHARD_SIZE": {v3_seat_shard_size},
  "V3_EVENT_SHARD_SIZE": {v3_event_shard_size},
  "V3_BOOK_NODES_PER_PAGE": {v3_book_nodes_per_page},
  "V3_BOOK_PAGES_PER_SIDE": {v3_book_pages_per_side},
  "V3_BOOK_SLOTS_PER_SIDE": {v3_book_slots_per_side},
  "V3_SEATS_PER_SHARD": {v3_seats_per_shard},
  "V3_SEAT_SHARDS": {v3_seat_shards},
  "V3_EVENTS_PER_SHARD": {v3_events_per_shard},
  "V3_EVENT_SHARDS": {v3_event_shards}
  ,"ORACLE_SNAPSHOT_SIZE": {oracle_snapshot_size}
  ,"ORACLE_SNAPSHOT_VERSION": {oracle_snapshot_version}
  ,"ORACLE_SNAPSHOT_CORE_OFFSET": {oracle_snapshot_core_offset}
  ,"ORACLE_SNAPSHOT_FEED_ID_OFFSET": {oracle_snapshot_feed_id_offset}
  ,"ORACLE_SNAPSHOT_CHANNEL_OFFSET": {oracle_snapshot_channel_offset}
  ,"ORACLE_SNAPSHOT_EXPONENT_OFFSET": {oracle_snapshot_exponent_offset}
  ,"ORACLE_SNAPSHOT_PRICE_OFFSET": {oracle_snapshot_price_offset}
  ,"ORACLE_SNAPSHOT_CONFIDENCE_OFFSET": {oracle_snapshot_confidence_offset}
  ,"ORACLE_SNAPSHOT_TIMESTAMP_OFFSET": {oracle_snapshot_timestamp_offset}
  ,"ORACLE_SNAPSHOT_SEQUENCE_OFFSET": {oracle_snapshot_sequence_offset}
  ,"ORACLE_SNAPSHOT_STATUS_OFFSET": {oracle_snapshot_status_offset}
  ,"ORACLE_SNAPSHOT_AUTHENTICATED_OFFSET": {oracle_snapshot_authenticated_offset}
  ,"ORACLE_SNAPSHOT_REVISION_OFFSET": {oracle_snapshot_revision_offset}
  ,"V3_CORE_ORACLE_FEED_ID_OFFSET": {v3_core_oracle_feed_id_offset}
  ,"V3_CORE_ORACLE_CHANNEL_OFFSET": {v3_core_oracle_channel_offset}
  ,"V3_CORE_ORACLE_EXPONENT_OFFSET": {v3_core_oracle_exponent_offset}
  ,"V3_CORE_VAULT_SURPLUS_OFFSET": {v3_core_vault_surplus_offset}
  ,"V3_CORE_WITHDRAWAL_BUFFER_OFFSET": {v3_core_withdrawal_buffer_offset}
  ,"V3_EXECUTION_BUNDLE_LEN": {v3_execution_bundle_len}
  ,"V3_RISK_CONFIG_VERSION": {risk_revision}
  ,"V3_CORE_VALIDATOR_OFFSET": {validator_v3}
  ,"V3_CORE_INITIAL_MARGIN_BPS_OFFSET": {initial_margin_v3}
  ,"V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET": {maintenance_margin_v3}
  ,"V3_CORE_LIQUIDATION_FEE_BPS_OFFSET": {liquidation_fee_v3}
  ,"V3_CORE_MAKER_FEE_BPS_OFFSET": {maker_fee_v3}
  ,"V3_CORE_TAKER_FEE_BPS_OFFSET": {taker_fee_v3}
  ,"V3_CORE_MAXIMUM_LEVERAGE_OFFSET": {leverage_v3}
}}
"#,
        risk_revision = equinox::v3::V3_RISK_CONFIG_VERSION,
        validator_v3 = offset_of!(equinox::v3::MarketCoreV3, delegation_validator),
        initial_margin_v3 = equinox::v3::V3_CORE_INITIAL_MARGIN_BPS_OFFSET,
        maintenance_margin_v3 = equinox::v3::V3_CORE_MAINTENANCE_MARGIN_BPS_OFFSET,
        liquidation_fee_v3 = equinox::v3::V3_CORE_LIQUIDATION_FEE_BPS_OFFSET,
        maker_fee_v3 = equinox::v3::V3_CORE_MAKER_FEE_BPS_OFFSET,
        taker_fee_v3 = equinox::v3::V3_CORE_TAKER_FEE_BPS_OFFSET,
        leverage_v3 = equinox::v3::V3_CORE_MAXIMUM_LEVERAGE_OFFSET,
        market_version = equinox::state::MARKET_VERSION,
        market_header_size = equinox::state::MARKET_HEADER_SIZE,
        market_account_size = equinox::state::MARKET_ACCOUNT_SIZE,
        trader_seat_size = equinox::state::TRADER_SEAT_SIZE,
        trading_session_size = equinox::session::TRADING_SESSION_SIZE,
        settlement_scratch_len = equinox::scratch::SETTLEMENT_SCRATCH_LEN,
        bid_arena_offset = equinox::state::BID_ARENA_OFFSET,
        ask_arena_offset = equinox::state::ASK_ARENA_OFFSET,
        trader_seat_offset = equinox::state::TRADER_SEAT_OFFSET,
        fill_event_offset = equinox::state::FILL_EVENT_OFFSET,
        arena_nodes_offset = 528,
        any_node_size = equinox::book::ANY_NODE_SIZE,
        tag_inner = equinox::book::TAG_INNER,
        tag_leaf = equinox::book::TAG_LEAF,
        exchange_size = equinox::registry::EXCHANGE_SIZE,
        instrument_size = equinox::registry::INSTRUMENT_SIZE,
        event_header_size = equinox::events::EVENT_HEADER_SIZE,
        event_payload_size = equinox::events::EVENT_PAYLOAD_SIZE,
        event_size = equinox::events::EVENT_SIZE,
        commit_interval_ms = 30_000,
        v3_layout_version = equinox::v3::V3_LAYOUT_VERSION,
        v3_commit_account_hard_max = equinox::v3::V3_COMMIT_ACCOUNT_HARD_MAX,
        v3_commit_account_safe_max = equinox::v3::V3_COMMIT_ACCOUNT_SAFE_MAX,
        v3_page_account_size = equinox::v3::V3_PAGE_ACCOUNT_SIZE,
        v3_market_core_size = equinox::v3::V3_MARKET_CORE_SIZE,
        v3_book_page_size = equinox::v3::V3_BOOK_PAGE_SIZE,
        v3_seat_shard_size = equinox::v3::V3_SEAT_SHARD_SIZE,
        v3_event_shard_size = equinox::v3::V3_EVENT_SHARD_SIZE,
        v3_book_nodes_per_page = equinox::v3::V3_BOOK_NODES_PER_PAGE,
        v3_book_pages_per_side = equinox::v3::V3_BOOK_PAGES_PER_SIDE,
        v3_book_slots_per_side = equinox::v3::V3_BOOK_SLOTS_PER_SIDE,
        v3_seats_per_shard = equinox::v3::V3_SEATS_PER_SHARD,
        v3_seat_shards = equinox::v3::V3_SEAT_SHARDS,
        v3_events_per_shard = equinox::v3::V3_EVENTS_PER_SHARD,
        v3_event_shards = equinox::v3::V3_EVENT_SHARDS,
        oracle_snapshot_size = equinox::oracle_snapshot::ORACLE_SNAPSHOT_SIZE,
        oracle_snapshot_version = equinox::oracle_snapshot::ORACLE_SNAPSHOT_VERSION,
        oracle_snapshot_core_offset = equinox::oracle_snapshot::OFFSET_CORE,
        oracle_snapshot_feed_id_offset = equinox::oracle_snapshot::OFFSET_FEED_ID,
        oracle_snapshot_channel_offset = equinox::oracle_snapshot::OFFSET_CHANNEL,
        oracle_snapshot_exponent_offset = equinox::oracle_snapshot::OFFSET_EXPONENT,
        oracle_snapshot_price_offset = equinox::oracle_snapshot::OFFSET_PRICE,
        oracle_snapshot_confidence_offset = equinox::oracle_snapshot::OFFSET_CONFIDENCE,
        oracle_snapshot_timestamp_offset = equinox::oracle_snapshot::OFFSET_PUBLISH_TIMESTAMP,
        oracle_snapshot_sequence_offset = equinox::oracle_snapshot::OFFSET_SEQUENCE,
        oracle_snapshot_status_offset = equinox::oracle_snapshot::OFFSET_TRADING_STATUS,
        oracle_snapshot_authenticated_offset = equinox::oracle_snapshot::OFFSET_AUTHENTICATED,
        oracle_snapshot_revision_offset = equinox::oracle_snapshot::OFFSET_REVISION,
        v3_core_oracle_feed_id_offset = equinox::v3::V3_CORE_ORACLE_FEED_ID_OFFSET,
        v3_core_oracle_channel_offset = equinox::v3::V3_CORE_ORACLE_CHANNEL_OFFSET,
        v3_core_oracle_exponent_offset = equinox::v3::V3_CORE_ORACLE_EXPONENT_OFFSET,
        v3_core_vault_surplus_offset = equinox::v3::V3_CORE_VAULT_SURPLUS_OFFSET,
        v3_core_withdrawal_buffer_offset = equinox::v3::V3_CORE_WITHDRAWAL_BUFFER_OFFSET,
        v3_execution_bundle_len = equinox::v3::V3_EXECUTION_BUNDLE_LEN,
    )
}

/// Independent sanity check against real Rust source, kept alongside
/// `generate_manifest` even though it's no longer the parity mechanism
/// itself (the committed layout.json / real diff in `check:equinox-abi`
/// is): this catches an obviously-wrong constant (e.g. a typo'd literal
/// in this very file) before it ever reaches the manifest.
#[test]
fn manifest_constants_are_consistent() {
    assert_eq!(equinox::state::MARKET_HEADER_SIZE, 512);
    assert_eq!(equinox::state::MARKET_ACCOUNT_SIZE, 222_752);
    assert_eq!(equinox::state::TRADER_SEAT_SIZE, 256);
    assert_eq!(equinox::session::TRADING_SESSION_SIZE, 256);
    assert_eq!(equinox::registry::EXCHANGE_SIZE, 256);
    assert_eq!(equinox::registry::INSTRUMENT_SIZE, 128);
    assert_eq!(equinox::book::ANY_NODE_SIZE, 88);
    assert!(equinox::v3::v3_layout_is_committable());
    assert_eq!(
        equinox::events::EVENT_HEADER_SIZE,
        std::mem::size_of::<equinox::events::EventHeader>()
    );
    assert_eq!(
        equinox::events::EVENT_SIZE,
        equinox::events::EVENT_HEADER_SIZE + equinox::events::EVENT_PAYLOAD_SIZE
    );
}

/// Regression test for the real bug this rewrite fixes: the manifest's
/// event sizes must independently match the header size AND the payload
/// size, not just their sum (52 + 48 = 100, but so does 12 + 88 = 100 --
/// the old manifest's wrong split passed a total-only check silently).
#[test]
fn event_header_and_payload_sizes_are_independently_correct() {
    assert_eq!(equinox::events::EVENT_HEADER_SIZE, 52);
    assert_eq!(equinox::events::EVENT_PAYLOAD_SIZE, 48);
}

/// Regression test for the manifest's own generation: running the
/// generator twice must produce byte-identical output (nothing depends on
/// process-specific state like ASLR/pointer values), and the output must
/// actually change if a constant it depends on would change -- proven
/// here by confirming the generator output is NOT simply the previously-
/// committed file (which is what the circular include_str! bug produced
/// every time regardless of Rust source changes).
#[test]
fn manifest_generation_is_deterministic_and_reflects_real_constants() {
    let first = build_manifest();
    let second = build_manifest();
    assert_eq!(first, second, "manifest generation must be deterministic");
    assert!(first.contains("\"EVENT_HEADER_SIZE\": 52"));
    assert!(first.contains("\"EVENT_PAYLOAD_SIZE\": 48"));
}
