//! One Pyth refresh of the first market's L1 snapshot, then exit. For testing the
//! refresher from the VM without touching the running service:
//! PYTH_PRO_API_KEY=... MM_KEEPER_KEYPAIR=... refresh_once

use anyhow::{anyhow, Context, Result};
use equinox_market_maker::pyth_refresh::PythRefresher;
use equinox_market_maker::solana::{pubkey, Keypair};
use serde_json::Value;

const DEPLOYMENT: &str = include_str!("../../../../config/equinox-deployment.json");

fn env(name: &str) -> Result<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty()).ok_or_else(|| anyhow!("{name} is not set"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let deployment: Value = serde_json::from_str(DEPLOYMENT)?;
    let text = |value: &Value| value.as_str().map(str::to_string).ok_or_else(|| anyhow!("deployment field missing"));
    let market = deployment["markets"].as_array().and_then(|list| list.first()).unwrap_or(&deployment);
    let url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
    let send = std::env::var("SOLANA_SEND_URL").unwrap_or_else(|_| url.clone());
    let key_path = env("MM_KEEPER_KEYPAIR")?;
    let refresher = PythRefresher::new(
        &url,
        &send,
        env("PYTH_PRO_API_KEY")?,
        Keypair::from_json(&std::fs::read_to_string(&key_path).with_context(|| format!("reading {key_path}"))?)?,
        pubkey(&text(&deployment["programId"])?)?,
        pubkey(&text(&market["core"])?)?,
        pubkey(&text(&market["oracleSnapshot"])?)?,
        u32::try_from(market["oracle"]["feedId"].as_u64().ok_or_else(|| anyhow!("no feed id"))?)?,
        text(&deployment["oracle"]["channel"])?,
    )?;
    refresher.refresh().await?;
    println!("refreshed");
    Ok(())
}
