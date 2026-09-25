//! Keeps each delegated market core funded in the rollup. The core pays
//! MagicBlock's commit fees (100,000 lamports per account commit past the
//! sponsored allowance), so a core that runs down to rent makes every keeper
//! commit fail with `InsufficientFundsForRent`. This job checks the core's
//! rollup balance and, when it is low, sends lamports from the keeper key on
//! Solana with MagicBlock's delegated-lamports transfer.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use equinox::magicblock::DELEGATION_PROGRAM_ID;
use rand::RngCore;
use serde_json::json;

use crate::rpc::Rpc;
use crate::solana::{b58, find_program_address, pubkey, sign_transaction, AccountMeta, Instruction, Keypair, Pubkey};

/// MagicBlock's ephemeral SPL token program, which handles delegated lamport transfers.
const EPHEMERAL_SPL_PROGRAM: &str = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";
const SYSTEM_PROGRAM: Pubkey = [0; 32];
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// MagicBlock `lamportsDelegatedTransferIx` (ephemeral-rollups-kit): move `amount`
/// lamports from `payer` on Solana to the delegated account `destination` in the rollup.
pub fn delegated_lamports_transfer(payer: &Pubkey, destination: &Pubkey, amount: u64, salt: &[u8; 32]) -> Result<Instruction> {
    let program = pubkey(EPHEMERAL_SPL_PROGRAM)?;
    let delegation = DELEGATION_PROGRAM_ID.to_bytes();
    let rent = find_program_address(&[b"rent"], &program);
    let lamports = find_program_address(&[b"lamports", payer, destination, salt], &program);
    let meta = |pubkey: Pubkey, is_signer: bool, is_writable: bool| AccountMeta { pubkey, is_signer, is_writable };
    let mut data = Vec::with_capacity(41);
    data.push(20);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(salt);
    Ok(Instruction {
        program_id: program,
        accounts: vec![
            meta(*payer, true, true),
            meta(rent, false, true),
            meta(lamports, false, true),
            meta(program, false, false),
            meta(find_program_address(&[b"buffer", &lamports], &program), false, true),
            meta(find_program_address(&[b"delegation", &lamports], &delegation), false, true),
            meta(find_program_address(&[b"delegation-metadata", &lamports], &delegation), false, true),
            meta(delegation, false, false),
            meta(SYSTEM_PROGRAM, false, false),
            meta(*destination, false, true),
            meta(find_program_address(&[b"delegation", destination], &delegation), false, false),
        ],
        data,
    })
}

pub struct CoreTopUp {
    rollup: Rpc,
    l1: Rpc,
    sender: Rpc,
    key: Keypair,
    core: Pubkey,
    symbol: String,
    /// Top up when the core's rollup balance falls below this.
    min: u64,
    /// How much to send each time.
    amount: u64,
}

impl CoreTopUp {
    pub fn new(rollup_url: &str, l1_url: &str, send_url: &str, key: Keypair, core: Pubkey, symbol: String, min_sol: f64, amount_sol: f64) -> Result<Self> {
        let lamports = |sol: f64| (sol * LAMPORTS_PER_SOL as f64) as u64;
        Ok(Self { rollup: Rpc::new(rollup_url)?, l1: Rpc::new(l1_url)?, sender: Rpc::new(send_url)?, key, core, symbol, min: lamports(min_sol), amount: lamports(amount_sol) })
    }

    pub async fn run(self: Arc<Self>, every: Duration) {
        loop {
            if let Err(error) = self.check().await {
                tracing::warn!(market = %self.symbol, "core top-up: {error:#}");
            }
            tokio::time::sleep(every).await;
        }
    }

    async fn balance(rpc: &Rpc, key: &Pubkey) -> Result<u64> {
        let result = rpc.call("getBalance", json!([b58(key), { "commitment": "confirmed" }])).await?;
        result["value"].as_u64().context("getBalance: no value")
    }

    async fn check(&self) -> Result<()> {
        let before = Self::balance(&self.rollup, &self.core).await.context("reading the core's rollup balance")?;
        if before >= self.min {
            return Ok(());
        }
        let payer = self.key.pubkey();
        let available = Self::balance(&self.l1, &payer).await.context("reading the keeper's balance")?;
        // Keep enough behind for the keeper's own fees and price posts.
        if available < self.amount + LAMPORTS_PER_SOL / 10 {
            anyhow::bail!("core is low ({before} lamports) but the keeper {} holds only {available}; fund it", b58(&payer));
        }
        let mut salt = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut salt);
        let instruction = delegated_lamports_transfer(&payer, &self.core, self.amount, &salt)?;
        let blockhash = self.l1.latest_blockhash().await?;
        let (wire, _) = sign_transaction(&self.key, &[instruction], &blockhash)?;
        let signature = self.sender.send_transaction(&wire).await?;
        tracing::info!(market = %self.symbol, before, amount = self.amount, %signature, "topped up the core's rollup balance");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values from @magicblock-labs/ephemeral-rollups-kit's
    // lamportsDelegatedTransferIx for the same inputs.
    #[test]
    fn matches_magicblock_kit_layout() {
        let payer = pubkey("7JuUhGGGcu2t2De6VQecNCqhWPwu8QzmztWXW9kYNKFz").unwrap();
        let core = pubkey("2QtGrh5xcTTndFTxUD7hEShSQdfAhyT8Z4nPGyTF9VSj").unwrap();
        let ix = delegated_lamports_transfer(&payer, &core, 500_000_000, &[7u8; 32]).unwrap();
        let expected: &[&str] = &include!("topup_expected.txt");
        let got: Vec<String> = ix.accounts.iter().map(|a| format!("{} {} {}", b58(&a.pubkey), a.is_signer, a.is_writable)).collect();
        assert_eq!(got, expected);
        assert_eq!(ix.data.len(), 41);
        assert_eq!(ix.data[0], 20);
        assert_eq!(u64::from_le_bytes(ix.data[1..9].try_into().unwrap()), 500_000_000);
        assert_eq!(&ix.data[9..], &[7u8; 32]);
    }
}
