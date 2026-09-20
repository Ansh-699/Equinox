//! MagicBlock schedule-intent wire encoding.
//!
//! This keeps the fixed-size bincode-compatible encoder separate from the
//! account lifecycle and CPI orchestration in `magicblock.rs`.

use crate::{error::StockStreamError, v3};

/// Maximum number of delegated accounts StockStream may include in a V3
/// commit intent: core + 18 book pages + 4 seat shards + 4 event shards.
pub const MAX_COMMITTED_ACCOUNTS: usize = v3::V3_EXECUTION_BUNDLE_LEN;

/// Maximum commit-only ScheduleIntentBundle payload.
pub const SCHEDULE_COMMIT_DATA_MAX_LEN: usize = 28 + MAX_COMMITTED_ACCOUNTS;

/// Maximum commit-and-undelegate ScheduleIntentBundle payload.
pub const SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN: usize = 32 + MAX_COMMITTED_ACCOUNTS;

/// Shared fixed-capacity output buffer for both schedule encoders.
pub const SCHEDULE_DATA_MAX_LEN: usize = SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN;

/// Encodes `ScheduleIntentBundle` data committing the `committed_indices`
/// accounts (u8 indices into the instruction's `[payer, magic_context, ..]`
/// account list). `undelegate` selects the commit-only or
/// commit-and-undelegate intent. Returns the used prefix length.
pub fn encode_schedule_intent_bundle_data(
    indices: &[u8],
    undelegate: bool,
    out: &mut [u8; SCHEDULE_DATA_MAX_LEN],
) -> Result<usize, StockStreamError> {
    if indices.is_empty() || indices.len() > MAX_COMMITTED_ACCOUNTS {
        return Err(StockStreamError::MagicBlockInvalidAccount);
    }
    let len = if undelegate {
        SCHEDULE_COMMIT_AND_UNDELEGATE_DATA_MAX_LEN - MAX_COMMITTED_ACCOUNTS + indices.len()
    } else {
        SCHEDULE_COMMIT_DATA_MAX_LEN - MAX_COMMITTED_ACCOUNTS + indices.len()
    };
    out.fill(0);
    out[0..4].copy_from_slice(&11u32.to_le_bytes());
    let mut offset = 4usize;
    if undelegate {
        out[offset] = 0;
        offset += 1;
        out[offset] = 1;
        offset += 1;
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;
        out[offset..offset + 8].copy_from_slice(&(indices.len() as u64).to_le_bytes());
        offset += 8;
        out[offset..offset + indices.len()].copy_from_slice(indices);
        offset += indices.len();
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;
    } else {
        out[offset] = 1;
        offset += 1;
        out[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;
        out[offset..offset + 8].copy_from_slice(&(indices.len() as u64).to_le_bytes());
        offset += 8;
        out[offset..offset + indices.len()].copy_from_slice(indices);
        offset += indices.len();
    }
    if undelegate {
        offset += 2;
    } else {
        offset += 3;
    }
    out[offset..offset + 8].copy_from_slice(&0u64.to_le_bytes());
    offset += 8;
    if offset != len {
        return Err(StockStreamError::MagicBlockInvalidAccount);
    }
    Ok(len)
}
