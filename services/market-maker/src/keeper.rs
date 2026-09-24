//! Keeper jobs for the V3 market, signed by the core's keeper key (opcode 64
//! names it; the program lets it fund, liquidate and commit-only snapshot,
//! nothing else):
//! - liquidation: every few seconds, re-score every seat with the program's
//!   own risk math and liquidate the ones under maintenance margin;
//! - funding: hourly, move the accumulator by the premium of the book's mark
//!   over the oracle (the program caps and verifies the step);
//! - commit: every few minutes, write the rollup state back to Solana
//!   (26 child shards, then the core). Trading pauses while a snapshot is
//!   open, so the maker stands down for those ~1-2 s.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::json;
use stockstream::instruction::{ABORT_V3_SNAPSHOT, COMMIT_MARKET, LIQUIDATE, UPDATE_FUNDING};
use stockstream::magicblock::{DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use stockstream::risk::{is_liquidatable, settle_funding};
use stockstream::v3::{
    read_shard_seat, read_v3_risk_config, V3_CORE_CHILD_RECORDS_OFFSET, V3_CORE_CHILD_RECORD_SIZE,
    V3_CORE_COMMIT_PHASE_OFFSET, V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET, V3_CORE_FUNDING_ACCUMULATOR_OFFSET,
    V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET, V3_CORE_SNAPSHOT_EPOCH_OFFSET,
    V3_COMMIT_PHASE_SNAPSHOT, V3_CORE_DELEGATION_STATUS_OFFSET, V3_CORE_VALIDATOR_OFFSET, V3_SEATS_PER_SHARD,
};
use tokio::sync::Mutex;

use crate::maker::{now_ms, MarketConfig, Status};
use crate::rpc::{Rpc, SignatureSocket};
use crate::solana::{b58, find_program_address, set_compute_unit_limit, sign_transaction, AccountMeta, Instruction, Keypair, Pubkey};
use crate::v3::{best_prices, snapshot, Bundle};

const LIQUIDATION_SCAN_EVERY: Duration = Duration::from_secs(3);
/// The program refuses prices older than 10 s; leave room for the send.
const MAX_PRICE_AGE_S: u64 = 7;
/// A shard digest plus the Magic commit CPI exceeds the 200k default.
const COMMIT_COMPUTE_UNITS: u32 = 1_400_000;
const COMPUTE_UNITS: u32 = 600_000;

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperStatus {
    pub key: String,
    pub commits: u64,
    pub last_commit_sequence: Option<u64>,
    pub last_commit_at: Option<u64>,
    /// Snapshot open to closed: how long trading paused.
    pub last_commit_ms: Option<u64>,
    pub funding_updates: u64,
    pub last_funding_at: Option<u64>,
    pub last_funding_step: Option<String>,
    pub liquidations: u64,
    pub last_liquidation_at: Option<u64>,
    pub errors: u64,
    pub last_error: Option<String>,
}

pub struct Keeper {
    rpc: Rpc,
    rpc_url: String,
    symbol: String,
    primary: bool,
    bundle: Bundle,
    key: Keypair,
    /// Set while a snapshot is open: the maker skips its ticks.
    pub committing: Arc<AtomicBool>,
    status: Arc<Mutex<Status>>,
    commit_every: Duration,
    funding_every: Duration,
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"))
}
fn i128_at(bytes: &[u8], offset: usize) -> i128 {
    i128::from_le_bytes(bytes[offset..offset + 16].try_into().expect("16 bytes"))
}

/// Funding step the program will accept: it only moves up, by at most one
/// unit per elapsed second and at most the premium (in bps) of mark over oracle.
pub fn funding_step(mark: i128, oracle: i128, elapsed_s: u64) -> i128 {
    if oracle <= 0 || mark <= oracle {
        return 0;
    }
    ((mark - oracle) * 10_000 / oracle).min(i128::from(elapsed_s))
}

/// The program's mark: mid of the best bid and ask (or the one side present,
/// or the oracle), clamped to the configured deviation from the oracle.
pub fn funding_mark(best_bid: Option<i64>, best_ask: Option<i64>, oracle: i64, deviation_bps: u16) -> i128 {
    let mark = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) if ask > bid => (i128::from(bid) + i128::from(ask)) / 2,
        (Some(bid), None) => i128::from(bid),
        (None, Some(ask)) => i128::from(ask),
        _ => i128::from(oracle),
    };
    let deviation = if deviation_bps == 0 { 500 } else { i128::from(deviation_bps) };
    let band = i128::from(oracle) * deviation / 10_000;
    mark.clamp((i128::from(oracle) - band).max(1), i128::from(oracle) + band)
}

impl Keeper {
    pub fn new(rpc_url: &str, market: &MarketConfig, key: Keypair, status: Arc<Mutex<Status>>, committing: Arc<AtomicBool>, commit_every: Duration, funding_every: Duration) -> Result<Self> {
        Ok(Self { rpc: Rpc::new(rpc_url)?, rpc_url: rpc_url.to_string(), symbol: market.symbol.clone(), primary: market.primary, bundle: market.bundle.clone(), key, committing, status, commit_every, funding_every })
    }

    pub fn pubkey(&self) -> Pubkey {
        self.key.pubkey()
    }

    pub async fn run(self: Arc<Self>) {
        {
            let initial = KeeperStatus { key: b58(&self.key.pubkey()), ..KeeperStatus::default() };
            let mut status = self.status.lock().await;
            status.market(&self.symbol).keeper = Some(initial.clone());
            if self.primary {
                status.keeper = Some(initial);
            }
        }
        let start = Instant::now();
        let (mut next_commit, mut next_funding) = (start + Duration::from_secs(20), start + Duration::from_secs(40));
        loop {
            // Only a market in the rollup has anything to fund, liquidate or commit.
            let core = self.rpc.account(&self.bundle.core).await.ok().flatten();
            if core.is_none_or(|core| core.get(V3_CORE_DELEGATION_STATUS_OFFSET) != Some(&1)) {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            let liquidated = self.liquidations().await;
            self.record("liquidation", liquidated.map(|count| {
                move |k: &mut KeeperStatus| {
                    if count > 0 {
                        k.liquidations += count;
                        k.last_liquidation_at = Some(now_ms());
                    }
                }
            }))
            .await;
            if Instant::now() >= next_funding {
                next_funding = Instant::now() + self.funding_every;
                let funded = self.funding().await;
                self.record("funding", funded.map(|step| {
                    move |k: &mut KeeperStatus| {
                        if let Some(step) = step {
                            k.funding_updates += 1;
                            k.last_funding_at = Some(now_ms());
                            k.last_funding_step = Some(step.to_string());
                        }
                    }
                }))
                .await;
            }
            if Instant::now() >= next_commit {
                let committed = self.commit().await;
                next_commit = Instant::now() + self.commit_every;
                self.record("commit", committed.map(|(sequence, paused)| {
                    move |k: &mut KeeperStatus| {
                        k.commits += 1;
                        k.last_commit_sequence = Some(sequence);
                        k.last_commit_at = Some(now_ms());
                        k.last_commit_ms = Some(paused);
                    }
                }))
                .await;
            }
            tokio::time::sleep(LIQUIDATION_SCAN_EVERY).await;
        }
    }

    async fn record(&self, job: &str, outcome: Result<impl FnOnce(&mut KeeperStatus)>) {
        let mut status = self.status.lock().await;
        let Some(keeper) = status.market(&self.symbol).keeper.as_mut() else { return };
        match outcome {
            Ok(apply) => apply(keeper),
            Err(error) => {
                keeper.errors += 1;
                keeper.last_error = Some(format!("{job}: {error:#}").chars().take(300).collect());
                tracing::warn!(market = %self.symbol, "keeper {job} failed: {error:#}");
            }
        }
        if self.primary {
            status.keeper = status.markets.get(&self.symbol).and_then(|m| m.keeper.clone());
        }
    }

    /// Signs, subscribes, sends and waits for the rollup's "processed" push.
    async fn send(&self, socket: &SignatureSocket, instructions: &[Instruction]) -> Result<String> {
        let blockhash = self.rpc.latest_blockhash().await?;
        let (wire, signature) = sign_transaction(&self.key, instructions, &blockhash)?;
        let signature = b58(&signature);
        let watch = socket.watch(&signature).await?;
        self.rpc.send_transaction(&wire).await?;
        match watch.processed(Duration::from_secs(10)).await {
            Some((_, true, _)) => Ok(signature),
            Some((_, false, _)) => Err(anyhow!("{signature} failed: {}", self.simulate(instructions).await.err().map_or_else(String::new, |e| format!("{e:#}")))),
            None => Err(anyhow!("{signature} was not confirmed within 10 s")),
        }
    }

    /// Ok when the rollup would accept these instructions now; the error carries its logs.
    async fn simulate(&self, instructions: &[Instruction]) -> Result<()> {
        let blockhash = self.rpc.latest_blockhash().await?;
        let (wire, _) = sign_transaction(&self.key, instructions, &blockhash)?;
        let result = self.rpc.call("simulateTransaction", json!([B64.encode(wire), { "encoding": "base64", "sigVerify": false }])).await?;
        let value = &result["value"];
        if value["err"].is_null() {
            return Ok(());
        }
        let logs: Vec<&str> = value["logs"].as_array().into_iter().flatten().filter_map(|l| l.as_str()).filter(|l| l.contains("failed") || l.contains("Error") || l.contains("error")).collect();
        bail!("{} {}", value["err"], logs.join(" | "))
    }

    fn execution(&self, data: Vec<u8>) -> Instruction {
        Instruction { program_id: self.bundle.program, accounts: self.bundle.metas(&self.key.pubkey()), data }
    }

    async fn fresh_price(&self, snapshot_bytes: &[u8]) -> Option<i64> {
        let snap = snapshot(snapshot_bytes)?;
        (snap.open && (now_ms() / 1_000).saturating_sub(snap.published) <= MAX_PRICE_AGE_S && snap.price > 0).then_some(snap.price)
    }

    /// Liquidates every seat the program would call under maintenance margin.
    async fn liquidations(&self) -> Result<u64> {
        let mut keys = vec![self.bundle.core, self.bundle.oracle_snapshot];
        keys.extend(&self.bundle.seat_shards);
        let accounts = self.rpc.multiple_accounts(&keys).await?;
        let (Some(core), Some(snap)) = (&accounts[0], &accounts[1]) else { bail!("core or oracle snapshot missing") };
        let Some(price) = self.fresh_price(snap).await else { return Ok(0) }; // the maker refreshes it
        let config = read_v3_risk_config(core).map_err(|e| anyhow!("risk config: {e:?}"))?;
        let accumulator = i128_at(core, V3_CORE_FUNDING_ACCUMULATOR_OFFSET);
        let mut due = Vec::new();
        for (shard, bytes) in accounts[2..].iter().enumerate() {
            let Some(bytes) = bytes else { continue };
            for slot in 0..V3_SEATS_PER_SHARD {
                let Ok(mut seat) = read_shard_seat(bytes, slot) else { continue };
                if seat.base_position == 0 {
                    continue;
                }
                if settle_funding(&mut seat, accumulator).is_ok() && is_liquidatable(&seat, i128::from(price), config.maintenance_margin_bps).unwrap_or(false) {
                    due.push((shard * V3_SEATS_PER_SHARD + slot) as u16);
                }
            }
        }
        if due.is_empty() {
            return Ok(0);
        }
        let socket = SignatureSocket::connect(&self.rpc_url).await?;
        let mut done = 0;
        for seat in due {
            let mut data = vec![LIQUIDATE];
            data.extend_from_slice(&seat.to_le_bytes());
            data.extend_from_slice(&u64::MAX.to_le_bytes()); // the program takes half, at least 1
            let signature = self.send(&socket, &[set_compute_unit_limit(COMPUTE_UNITS), self.execution(data)]).await?;
            tracing::info!(seat, %signature, "liquidated");
            done += 1;
        }
        Ok(done)
    }

    /// One funding step; `None` when there is nothing to accrue.
    async fn funding(&self) -> Result<Option<i128>> {
        let mut keys = vec![self.bundle.core, self.bundle.oracle_snapshot];
        keys.extend(&self.bundle.book_pages);
        let accounts = self.rpc.multiple_accounts(&keys).await?;
        let (Some(core), Some(snap)) = (&accounts[0], &accounts[1]) else { bail!("core or oracle snapshot missing") };
        let Some(oracle) = self.fresh_price(snap).await else { bail!("price is stale or the market is closed") };
        let config = read_v3_risk_config(core).map_err(|e| anyhow!("risk config: {e:?}"))?;
        let now_s = now_ms() / 1_000;
        let (bid, ask) = best_prices(accounts[2..].iter().flatten().map(Vec::as_slice), now_s, oracle / 2);
        let previous = i128_at(core, V3_CORE_FUNDING_ACCUMULATOR_OFFSET);
        // The rollup's clock trails wall time by 1-2 s; never stamp ahead of it.
        let timestamp = now_s.saturating_sub(3).max(u64_at(core, V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET));
        let elapsed = timestamp - u64_at(core, V3_CORE_LAST_FUNDING_TIMESTAMP_OFFSET);
        let step = funding_step(funding_mark(bid, ask, oracle, config.mark_deviation_bps), i128::from(oracle), elapsed);
        let instruction = |step: i128| {
            let mut data = vec![UPDATE_FUNDING];
            data.extend_from_slice(&(previous + step).to_le_bytes());
            data.extend_from_slice(&timestamp.to_le_bytes());
            [set_compute_unit_limit(COMPUTE_UNITS), self.execution(data)]
        };
        // Our mark reads fixed-price leaves only; if the program's differs, just advance the clock.
        let step = if step > 0 && self.simulate(&instruction(step)).await.is_err() { 0 } else { step };
        let socket = SignatureSocket::connect(&self.rpc_url).await?;
        let signature = self.send(&socket, &instruction(step)).await?;
        tracing::info!(step, %signature, "funding updated");
        Ok(Some(step))
    }

    /// The core pays each commit through the validator's magic fee vault, which
    /// lifts MagicBlock's 10-commits-per-delegation cap.
    fn commit_instruction(&self, account: Pubkey, sequence: u64, with_core: bool, fee_vault: Pubkey) -> [Instruction; 2] {
        let key = self.key.pubkey();
        let mut accounts = vec![
            AccountMeta { pubkey: account, is_signer: false, is_writable: true },
            AccountMeta { pubkey: key, is_signer: true, is_writable: false },
            AccountMeta { pubkey: key, is_signer: true, is_writable: true },
            AccountMeta { pubkey: MAGIC_CONTEXT_ID.to_bytes(), is_signer: false, is_writable: true },
            AccountMeta { pubkey: MAGIC_PROGRAM_ID.to_bytes(), is_signer: false, is_writable: false },
        ];
        if with_core {
            accounts.push(AccountMeta { pubkey: self.bundle.core, is_signer: false, is_writable: true });
        }
        accounts.push(AccountMeta { pubkey: fee_vault, is_signer: false, is_writable: true });
        let mut data = vec![COMMIT_MARKET];
        data.extend_from_slice(&sequence.to_le_bytes());
        [set_compute_unit_limit(COMMIT_COMPUTE_UNITS), Instruction { program_id: self.bundle.program, accounts, data }]
    }

    /// Commits the 26 children, then the core; resumes a snapshot a crash left open.
    async fn commit(&self) -> Result<(u64, u64)> {
        let socket = SignatureSocket::connect(&self.rpc_url).await?;
        let children: Vec<Pubkey> = self.bundle.book_pages.iter().chain(&self.bundle.seat_shards).chain(&self.bundle.event_shards).copied().collect();
        self.committing.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let result = async {
            // Read the core once: reads lag the "processed" pushes we wait on, so
            // each step's sequence is counted here (every commit advances it by one).
            let core = self.rpc.account_processed(&self.bundle.core).await?.ok_or_else(|| anyhow!("core missing"))?;
            let mut sequence = u64_at(&core, V3_CORE_EXPECTED_COMMIT_SEQUENCE_OFFSET);
            let open = core[V3_CORE_COMMIT_PHASE_OFFSET] == V3_COMMIT_PHASE_SNAPSHOT;
            let validator = &core[V3_CORE_VALIDATOR_OFFSET..V3_CORE_VALIDATOR_OFFSET + 32];
            let fee_vault = find_program_address(&[b"magic-fee-vault", validator], &DELEGATION_PROGRAM_ID.to_bytes());
            for (index, child) in children.iter().enumerate() {
                let record = V3_CORE_CHILD_RECORDS_OFFSET + index * V3_CORE_CHILD_RECORD_SIZE;
                if open && u64_at(&core, record) == u64_at(&core, V3_CORE_SNAPSHOT_EPOCH_OFFSET) {
                    continue; // already in this snapshot
                }
                self.send(&socket, &self.commit_instruction(*child, sequence, true, fee_vault)).await.map_err(|e| anyhow!("child {index}: {e:#}"))?;
                sequence += 1;
            }
            self.send(&socket, &self.commit_instruction(self.bundle.core, sequence, false, fee_vault)).await.map_err(|e| anyhow!("core: {e:#}"))?;
            Ok::<_, anyhow::Error>(sequence)
        }
        .await;
        if let Err(error) = &result {
            // An open snapshot freezes trading: close it rather than leave the market stuck.
            let abort = Instruction {
                program_id: self.bundle.program,
                accounts: vec![
                    AccountMeta { pubkey: self.bundle.core, is_signer: false, is_writable: true },
                    AccountMeta { pubkey: self.key.pubkey(), is_signer: true, is_writable: false },
                ],
                data: vec![ABORT_V3_SNAPSHOT],
            };
            let aborted = self.send(&socket, &[abort]).await;
            tracing::warn!(aborted = aborted.is_ok(), "commit failed ({error:#}); snapshot closed so trading continues");
        }
        self.committing.store(false, Ordering::SeqCst);
        let paused = started.elapsed().as_millis() as u64;
        let sequence = result?;
        tracing::info!(sequence, paused_ms = paused, "committed rollup state to Solana");
        Ok((sequence, paused))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn funding_step_follows_the_program_rules() {
        // Mark 0.5% over the oracle: 50 bps, but never more than the elapsed seconds.
        assert_eq!(funding_step(100_500, 100_000, 3_600), 50);
        assert_eq!(funding_step(100_500, 100_000, 20), 20);
        // At or under the oracle the accumulator cannot move (it only goes up).
        assert_eq!(funding_step(99_000, 100_000, 3_600), 0);
        assert_eq!(funding_step(100_000, 100_000, 3_600), 0);
    }

    #[test]
    fn funding_mark_is_the_clamped_mid() {
        assert_eq!(funding_mark(Some(99), Some(101), 100, 0), 100);
        assert_eq!(funding_mark(Some(150), None, 100, 0), 105); // 500 bps default clamp
        assert_eq!(funding_mark(None, None, 100, 100), 100);
        assert_eq!(funding_mark(Some(103), Some(102), 100, 0), 100); // crossed: oracle
    }
}
