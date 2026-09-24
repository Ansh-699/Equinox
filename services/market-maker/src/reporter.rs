//! Price reporter for markets with no Pyth feed (pre-IPO perps). Every second
//! it reads the market's L1 oracle snapshot and PreStocks' prices, and posts a
//! new price (opcode 67) when the snapshot is getting old or the price moved.
//!
//! The index is the PreStocks token's on-chain price (what holders trade), kept
//! within ±50% of PreStocks' mark for the private company. The program caps
//! each post at 0.5% + 0.1% per elapsed second (≤ 10%), so a large move is
//! walked in over a few posts rather than jumped.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use stockstream::instruction::REPORT_PRICE_V3;
use stockstream::oracle_snapshot::{OFFSET_AUTHENTICATED, OFFSET_PRICE, OFFSET_PUBLISH_TIMESTAMP};
use tokio::sync::Mutex;

use crate::maker::{now_ms, Status};
use crate::rpc::Rpc;
use crate::solana::{b58, sign_transaction, AccountMeta, Instruction, Keypair, Pubkey};

const PRESTOCKS_API: &str = "https://prestocks.com/api/prestocks";
/// Post when the snapshot is this old: orders accept prices up to 10 s old.
const POST_WHEN_AGE_S: u64 = 4;
/// ...or when the target moved more than this (bps).
const POST_WHEN_MOVED_BPS: i128 = 20;
/// One PreStocks request serves every market; it is asked at most this often
/// (successful or not): their prices move slowly and the API rate-limits.
const API_EVERY: Duration = Duration::from_secs(15);

/// PreStocks' price list, shared by every reporter.
#[derive(Default)]
pub struct PreStocksFeed {
    last: Mutex<Option<(Instant, Option<Value>)>>,
    http: reqwest::Client,
}

impl PreStocksFeed {
    /// (mark, token price) for `token`, from a list at most `API_EVERY` old.
    async fn prices(&self, token: &str) -> Result<(f64, Option<f64>)> {
        let mut last = self.last.lock().await;
        if last.as_ref().is_none_or(|(at, _)| at.elapsed() > API_EVERY) {
            let fetched = async { self.http.get(PRESTOCKS_API).header("accept", "application/json").timeout(Duration::from_secs(10)).send().await?.error_for_status()?.json::<Value>().await }.await;
            // Keep the previous list on failure: stale by seconds beats hammering the API.
            let previous = last.take().and_then(|(_, rows)| rows);
            *last = Some((Instant::now(), fetched.ok().or(previous)));
        }
        let rows = last.as_ref().and_then(|(_, rows)| rows.as_ref()).ok_or_else(|| anyhow!("PreStocks API unavailable"))?;
        let row = rows.as_array().into_iter().flatten().find(|r| r["symbol"].as_str() == Some(token)).ok_or_else(|| anyhow!("PreStocks has no {token}"))?;
        let mark = row["markPrice"].as_f64().filter(|m| *m > 0.0).ok_or_else(|| anyhow!("PreStocks {token} has no mark price"))?;
        Ok((mark, row["tokenPrice"].as_f64()))
    }
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReporterStatus {
    pub key: String,
    pub source: String,
    /// PreStocks' reference price for the private company.
    pub mark_price: Option<f64>,
    /// The PreStocks token's on-chain price.
    pub token_price: Option<f64>,
    /// Token over mark, percent.
    pub premium_pct: Option<f64>,
    /// Last price posted on chain.
    pub last_price: Option<f64>,
    pub last_posted_at: Option<u64>,
    pub posts: u64,
    pub errors: u64,
    pub last_error: Option<String>,
}

/// Where a reporter-priced market's price comes from.
#[derive(Clone, Debug)]
pub enum PriceSource {
    /// A PreStocks pre-IPO token: its on-chain price, within ±50% of PreStocks' mark.
    PreStocks { token: String },
    /// A token launched on Meteora DBC that graduated to a DAMM v2 pool (USDC
    /// quoted): the pool's price for `lot` tokens (launched tokens trade far
    /// below a cent, under the perps' 5-decimal price scale).
    MeteoraPool { pool: Pubkey, lot: f64 },
}

/// DAMM v2 pool: `sqrt_price` (Q64.64 of quote per base) sits at byte 456 of the
/// account, after the fee struct, both mints and vaults, liquidity and fee counters.
const DAMM_V2_SQRT_PRICE_OFFSET: usize = 456;

/// Quote (USDC) per base token from a DAMM v2 pool account, both 6 decimals.
pub fn damm_v2_price(pool: &[u8]) -> Option<f64> {
    let bytes: [u8; 16] = pool.get(DAMM_V2_SQRT_PRICE_OFFSET..DAMM_V2_SQRT_PRICE_OFFSET + 16)?.try_into().ok()?;
    let sqrt = u128::from_le_bytes(bytes) as f64 / 18_446_744_073_709_551_616.0;
    (sqrt > 0.0).then_some(sqrt * sqrt)
}

/// Largest move (bps) the program accepts after `elapsed_s` seconds, less a margin.
pub fn allowed_move_bps(elapsed_s: u64) -> i128 {
    i128::from(elapsed_s.saturating_mul(10).saturating_add(50).min(1_000)) - 5
}

/// The index: token price kept within ±50% of the mark (mark alone when there is no token price).
pub fn index_usd(mark: f64, token: Option<f64>) -> f64 {
    token.filter(|t| t.is_finite() && *t > 0.0).map_or(mark, |t| t.clamp(mark * 0.5, mark * 1.5))
}

/// The next price to post: `target`, stepped no further than the program allows from `previous`.
pub fn next_price(previous: i64, target: i64, elapsed_s: u64) -> i64 {
    if previous <= 0 {
        return target;
    }
    let band = i128::from(previous) * allowed_move_bps(elapsed_s) / 10_000;
    i128::from(target).clamp(i128::from(previous) - band, i128::from(previous) + band) as i64
}

pub struct Reporter {
    l1: Rpc,
    /// Sends go to a separate endpoint: a keyed RPC's free tier rate-limits sendTransaction.
    sender: Rpc,
    history: Arc<crate::candles::PriceHistory>,
    feed: Arc<PreStocksFeed>,
    key: Keypair,
    program: Pubkey,
    core: Pubkey,
    snapshot: Pubkey,
    source: PriceSource,
    symbol: String,
    status: Arc<Mutex<Status>>,
}

impl Reporter {
    #[allow(clippy::too_many_arguments)]
    pub fn new(l1_url: &str, send_url: &str, feed: Arc<PreStocksFeed>, history: Arc<crate::candles::PriceHistory>, key: Keypair, program: Pubkey, core: Pubkey, snapshot: Pubkey, source: PriceSource, symbol: String, status: Arc<Mutex<Status>>) -> Result<Self> {
        Ok(Self { l1: Rpc::new(l1_url)?, sender: Rpc::new(send_url)?, history, feed, key, program, core, snapshot, source, symbol, status })
    }

    /// `offset` staggers several reporters so their posts do not land together.
    pub async fn run(self: Arc<Self>, offset: Duration) {
        tokio::time::sleep(offset).await;
        self.status.lock().await.market(&self.symbol).reporter = Some(ReporterStatus { key: b58(&self.key.pubkey()), source: match &self.source {
            PriceSource::PreStocks { token } => format!("PreStocks {token}"),
            PriceSource::MeteoraPool { pool, lot } => format!("Meteora DAMM v2 {} × {lot}", b58(pool)),
        }, ..ReporterStatus::default() });
        let mut blockhash: Option<(Instant, [u8; 32])> = None;
        loop {
            let result = async {
                let (mark, token) = match &self.source {
                    PriceSource::PreStocks { token } => self.feed.prices(token).await.context("PreStocks API")?,
                    PriceSource::MeteoraPool { pool, lot } => {
                        let bytes = self.l1.account(pool).await?.ok_or_else(|| anyhow!("Meteora pool missing"))?;
                        let price = damm_v2_price(&bytes).ok_or_else(|| anyhow!("Meteora pool has no price"))? * lot;
                        (price, Some(price))
                    }
                };
                let snapshot = self.l1.account(&self.snapshot).await?.ok_or_else(|| anyhow!("oracle snapshot missing"))?;
                let previous = i64::from_le_bytes(snapshot[OFFSET_PRICE..OFFSET_PRICE + 8].try_into()?);
                let previous_publish = u64::from_le_bytes(snapshot[OFFSET_PUBLISH_TIMESTAMP..OFFSET_PUBLISH_TIMESTAMP + 8].try_into()?);
                let previous = if snapshot[OFFSET_AUTHENTICATED] == 1 { previous } else { 0 };
                let target = (index_usd(mark, token) * 1e5).round() as i64;
                let now_s = now_ms() / 1_000;
                // Devnet's clock trails wall time by 1-2 s; the program rejects prices from its future.
                let publish = now_s.saturating_sub(1).max(previous_publish + 1);
                let moved = previous > 0 && (i128::from(target) - i128::from(previous)).abs() * 10_000 > i128::from(previous) * POST_WHEN_MOVED_BPS;
                let posted = if previous == 0 || now_s.saturating_sub(previous_publish) >= POST_WHEN_AGE_S || moved {
                    let price = next_price(previous, target, publish.saturating_sub(previous_publish));
                    if blockhash.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(20)) {
                        blockhash = Some((Instant::now(), self.l1.latest_blockhash().await?));
                    }
                    let mut data = vec![REPORT_PRICE_V3];
                    data.extend_from_slice(&price.to_le_bytes());
                    data.extend_from_slice(&(price.unsigned_abs() / 200).to_le_bytes()); // ±0.5% confidence
                    data.extend_from_slice(&publish.to_le_bytes());
                    let ix = Instruction {
                        program_id: self.program,
                        accounts: vec![
                            AccountMeta { pubkey: self.snapshot, is_signer: false, is_writable: true },
                            AccountMeta { pubkey: self.core, is_signer: false, is_writable: false },
                            AccountMeta { pubkey: self.key.pubkey(), is_signer: true, is_writable: true },
                        ],
                        data,
                    };
                    let (wire, _) = sign_transaction(&self.key, &[ix], &blockhash.as_ref().expect("set above").1)?;
                    self.sender.send_transaction(&wire).await?;
                    Some(price)
                } else {
                    None
                };
                Ok::<_, anyhow::Error>((mark, token, posted))
            }
            .await;
            let mut status = self.status.lock().await;
            let Some(reporter) = status.market(&self.symbol).reporter.as_mut() else { continue };
            match result {
                Ok((mark, token, posted)) => {
                    reporter.mark_price = Some(mark);
                    reporter.token_price = token;
                    reporter.premium_pct = token.map(|t| ((t / mark - 1.0) * 1_000.0).round() / 10.0);
                    if let Some(price) = posted {
                        let history = self.history.clone();
                        let symbol = self.symbol.clone();
                        tokio::spawn(async move { history.record(&symbol, now_ms() / 1_000, price as f64 / 1e5).await });
                        reporter.posts += 1;
                        reporter.last_price = Some(price as f64 / 1e5);
                        reporter.last_posted_at = Some(now_ms());
                    }
                }
                Err(error) => {
                    reporter.errors += 1;
                    reporter.last_error = Some(format!("{error:#}").chars().take(300).collect());
                    blockhash = None;
                    tracing::warn!(market = %self.symbol, "reporter: {error:#}");
                }
            }
            drop(status);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_damm_v2_pool_price() {
        // The devnet graduation test pool: $2,000 market cap over 1e9 tokens.
        let mut pool = vec![0u8; 1_112];
        pool[456..472].copy_from_slice(&26_087_635_650_665_564u128.to_le_bytes());
        let price = damm_v2_price(&pool).unwrap();
        assert!((price - 2e-6).abs() < 1e-12, "{price}");
        assert_eq!(damm_v2_price(&[0u8; 100]), None);
    }

    #[test]
    fn index_follows_the_token_within_half_the_mark() {
        assert_eq!(index_usd(100.0, Some(120.0)), 120.0);
        assert_eq!(index_usd(100.0, Some(400.0)), 150.0);
        assert_eq!(index_usd(100.0, Some(10.0)), 50.0);
        assert_eq!(index_usd(100.0, None), 100.0);
    }

    #[test]
    fn a_big_move_is_walked_in_within_the_program_bound() {
        // One second: 0.6% allowed (less the margin) → 0.55%.
        assert_eq!(next_price(100_000_000, 200_000_000, 1), 100_550_000);
        assert_eq!(next_price(100_000_000, 99_000_000, 1), 99_450_000);
        // Small moves pass through untouched; the first price is taken as is.
        assert_eq!(next_price(100_000_000, 100_100_000, 5), 100_100_000);
        assert_eq!(next_price(0, 137_974_000, 0), 137_974_000);
        // Never more than 10% at once.
        assert_eq!(next_price(100_000_000, 300_000_000, 3_600), 109_950_000);
    }
}
