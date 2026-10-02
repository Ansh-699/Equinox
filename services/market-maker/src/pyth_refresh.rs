//! Keeps TSLA's L1 Pyth snapshot fresh from this VM, port of
//! `workers/src/oracle-refresh.ts`. The Worker's shared Cloudflare egress IPs get
//! `HTTP 429` from the public devnet RPC; this VM has its own IP and does not.
//! The program accepts any payer for a newer Pyth-signed price (the signature is the
//! authentication), so the keeper key only pays the fee and holds no market authority.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use equinox::instruction::UPDATE_ORACLE_SNAPSHOT_V3;
use equinox::oracle_snapshot::OFFSET_PUBLISH_TIMESTAMP;
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::maker::now_ms;
use crate::rpc::Rpc;
use crate::solana::{pubkey, sign_transaction, AccountMeta, Instruction, Keypair, Pubkey};

/// A snapshot younger than this is reused, so spend stays at one transaction per window.
const FRESH_SECONDS: u64 = 5;
const ATTEMPTS: usize = 3;
const RETRY_DELAY: Duration = Duration::from_millis(1_200);
const CONFIRM_FOR: Duration = Duration::from_secs(20);
const CONFIRM_EVERY: Duration = Duration::from_millis(1_500);
const ED25519_PROGRAM: &str = "Ed25519SigVerify111111111111111111111111111";
const PYTH_PROGRAM: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
const PYTH_STORAGE: &str = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const INSTRUCTIONS_SYSVAR: &str = "Sysvar1nstructions1111111111111111111111111";
/// Where the signed message starts inside the snapshot instruction's data.
const MESSAGE_OFFSET: usize = 4;
const PYTH_ENDPOINTS: [&str; 3] = [
    "https://pyth-lazer-0.dourolabs.app/v1/latest_price",
    "https://pyth-lazer-1.dourolabs.app/v1/latest_price",
    "https://pyth-lazer-2.dourolabs.app/v1/latest_price",
];

pub struct PythRefresher {
    l1: Rpc,
    sender: Rpc,
    http: reqwest::Client,
    api_key: String,
    key: Keypair,
    program: Pubkey,
    core: Pubkey,
    snapshot: Pubkey,
    feed_id: u32,
    channel: String,
    treasury: OnceCell<Pubkey>,
}

/// Ed25519 verify instruction for the Pyth Lazer message that the instruction at
/// `consumer_index` carries at `MESSAGE_OFFSET`.
pub fn ed25519_instruction(message: &[u8], consumer_index: u16) -> Result<Instruction> {
    if message.len() < 102 {
        bail!("invalid signed Pyth message");
    }
    let size = u16::from_le_bytes([message[100], message[101]]);
    if message.len() != 102 + usize::from(size) {
        bail!("invalid signed Pyth message framing");
    }
    let signature_offset = (MESSAGE_OFFSET + 4) as u16;
    let public_key_offset = signature_offset + 64;
    let mut data = vec![0u8; 16];
    data[0] = 1;
    for (at, value) in [(2, signature_offset), (4, consumer_index), (6, public_key_offset), (8, consumer_index), (10, public_key_offset + 32 + 2), (12, size), (14, consumer_index)] {
        data[at..at + 2].copy_from_slice(&value.to_le_bytes());
    }
    Ok(Instruction { program_id: pubkey(ED25519_PROGRAM)?, accounts: vec![], data })
}

pub fn snapshot_update_instruction(program: Pubkey, core: Pubkey, snapshot: Pubkey, payer: Pubkey, treasury: Pubkey, message: &[u8], ed25519_index: u16) -> Result<Instruction> {
    let mut data = vec![0u8; MESSAGE_OFFSET];
    data[0] = UPDATE_ORACLE_SNAPSHOT_V3;
    data[1..3].copy_from_slice(&ed25519_index.to_le_bytes());
    data.extend_from_slice(message);
    let meta = |pubkey: Pubkey, is_signer: bool, is_writable: bool| AccountMeta { pubkey, is_signer, is_writable };
    Ok(Instruction {
        program_id: program,
        accounts: vec![
            meta(snapshot, false, true),
            meta(core, false, false),
            meta(payer, true, true),
            meta(pubkey(PYTH_PROGRAM)?, false, false),
            meta(pubkey(PYTH_STORAGE)?, false, false),
            meta(treasury, false, true),
            meta(pubkey(SYSTEM_PROGRAM)?, false, false),
            meta(pubkey(INSTRUCTIONS_SYSVAR)?, false, false),
        ],
        data,
    })
}

impl PythRefresher {
    #[allow(clippy::too_many_arguments)]
    pub fn new(l1_url: &str, send_url: &str, api_key: String, key: Keypair, program: Pubkey, core: Pubkey, snapshot: Pubkey, feed_id: u32, channel: String) -> Result<Self> {
        Ok(Self {
            l1: Rpc::new(l1_url)?,
            sender: Rpc::new(send_url)?,
            http: reqwest::Client::builder().http1_only().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(8)).build()?,
            api_key,
            key,
            program,
            core,
            snapshot,
            feed_id,
            channel,
            treasury: OnceCell::new(),
        })
    }

    async fn snapshot_age_s(&self) -> Result<u64> {
        let data = self.l1.account(&self.snapshot).await?.ok_or_else(|| anyhow!("L1 oracle snapshot missing"))?;
        let published = u64::from_le_bytes(data.get(OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8).ok_or_else(|| anyhow!("oracle snapshot too short"))?.try_into()?);
        Ok((now_ms() / 1_000).saturating_sub(published))
    }

    /// Pyth's fee treasury, read once from the storage account.
    async fn treasury(&self) -> Result<Pubkey> {
        self.treasury
            .get_or_try_init(|| async {
                let storage = self.l1.account(&pubkey(PYTH_STORAGE)?).await?.ok_or_else(|| anyhow!("Pyth storage account unavailable"))?;
                let bytes = storage.get(40..72).ok_or_else(|| anyhow!("Pyth storage account too short"))?;
                Ok::<_, anyhow::Error>(bytes.try_into()?)
            })
            .await
            .copied()
    }

    /// Newest signed Solana-format update, trying each Pyth endpoint.
    async fn signed_message(&self) -> Result<Vec<u8>> {
        let body = json!({ "priceFeedIds": [self.feed_id], "properties": ["price", "exponent", "confidence", "marketSession", "feedUpdateTimestamp"], "formats": ["solana"], "jsonBinaryEncoding": "base64", "parsed": true, "channel": self.channel });
        let mut last = anyhow!("no Pyth endpoint responded");
        for endpoint in PYTH_ENDPOINTS {
            let attempt = async {
                let response = self.http.post(endpoint).bearer_auth(&self.api_key).json(&body).send().await?;
                if !response.status().is_success() {
                    bail!("Pyth {}", response.status().as_u16());
                }
                let body: Value = response.json().await?;
                let data = body["solana"]["data"].as_str().ok_or_else(|| anyhow!("Pyth response missing Solana payload"))?;
                Ok::<_, anyhow::Error>(B64.decode(data)?)
            }
            .await;
            match attempt {
                Ok(message) => return Ok(message),
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    /// True once `signature` is confirmed on L1; false on failure or timeout.
    async fn confirmed(&self, signature: &str) -> bool {
        let deadline = Instant::now() + CONFIRM_FOR;
        while Instant::now() < deadline {
            tokio::time::sleep(CONFIRM_EVERY).await;
            if let Ok(result) = self.l1.call("getSignatureStatuses", json!([[signature]])).await {
                let status = &result["value"][0];
                if !status["err"].is_null() {
                    return false;
                }
                if matches!(status["confirmationStatus"].as_str(), Some("confirmed" | "finalized")) {
                    return true;
                }
            }
        }
        false
    }

    /// Posts a newer Pyth price unless the snapshot is already fresh.
    pub async fn refresh(&self) -> Result<()> {
        if self.snapshot_age_s().await? < FRESH_SECONDS {
            return Ok(());
        }
        let treasury = self.treasury().await?;
        let mut failure = anyhow!("snapshot update not attempted");
        // Devnet's clock trails wall time by 1-2 s and the program refuses a price more
        // than 2 s ahead of it, so a brand-new Pyth price is sometimes rejected: wait for
        // the chain to catch up and retry with a newer signed price.
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RETRY_DELAY).await;
                if self.snapshot_age_s().await.is_ok_and(|age| age < FRESH_SECONDS) {
                    return Ok(()); // a concurrent refresh landed
                }
            }
            let message = self.signed_message().await.context("fetching the Pyth price")?;
            let blockhash = self.l1.latest_blockhash().await?;
            // No compute-budget prefix: the Ed25519 instruction must stay at index 0.
            let instructions = [
                ed25519_instruction(&message, 1)?,
                snapshot_update_instruction(self.program, self.core, self.snapshot, self.key.pubkey(), treasury, &message, 0)?,
            ];
            let (wire, signature) = sign_transaction(&self.key, &instructions, &blockhash)?;
            let id = crate::solana::b58(&signature);
            if let Err(error) = self.sender.send_transaction(&wire).await {
                failure = error.context("sending the snapshot update");
                continue;
            }
            if self.confirmed(&id).await || self.snapshot_age_s().await.is_ok_and(|age| age < FRESH_SECONDS) {
                return Ok(());
            }
            failure = anyhow!("snapshot update {id} was not confirmed");
        }
        Err(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(size: u16) -> Vec<u8> {
        let mut message: Vec<u8> = (0..102 + usize::from(size)).map(|i| (i * 7 + 3) as u8).collect();
        message[100..102].copy_from_slice(&size.to_le_bytes());
        message
    }

    #[test]
    fn ed25519_instruction_points_at_the_message_in_instruction_one() {
        let ix = ed25519_instruction(&message(10), 1).unwrap();
        assert!(ix.accounts.is_empty());
        // 1 signature, padding, then (offset, instruction index) pairs; message starts at 4 + 4 + 64 + 32 + 2.
        assert_eq!(ix.data, [1, 0, 8, 0, 1, 0, 72, 0, 1, 0, 106, 0, 10, 0, 1, 0]);
    }

    #[test]
    fn a_misframed_message_is_refused() {
        assert!(ed25519_instruction(&message(10)[..105], 1).is_err());
        assert!(ed25519_instruction(&[0u8; 50], 1).is_err());
    }

    #[test]
    fn snapshot_update_carries_the_message_after_the_four_byte_header() {
        let m = message(10);
        let ix = snapshot_update_instruction([9; 32], [1; 32], [2; 32], [3; 32], [4; 32], &m, 0).unwrap();
        assert_eq!(ix.data[..4], [58, 0, 0, 0]);
        assert_eq!(ix.data[4..], m[..]);
        assert_eq!(ix.accounts.len(), 8);
        assert_eq!((ix.accounts[0].pubkey, ix.accounts[0].is_writable), ([2; 32], true));
        assert!(ix.accounts[2].is_signer && ix.accounts[2].is_writable);
        assert_eq!((ix.accounts[5].pubkey, ix.accounts[5].is_writable), ([4; 32], true));
    }
}
