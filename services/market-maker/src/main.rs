//! Configuration (environment):
//! - `MM_MAKER_KEYPAIR`, `MM_TAKER_KEYPAIR`: paths to solana-keygen JSON files (required)
//! - `MAGICBLOCK_RPC_URL`: rollup RPC (default: the deployment's `magicBlock.rpc`)
//! - `MARKET_API_URL`: StockStream Worker, used for the permissionless Pyth refresh
//! - `MM_STATUS_ADDR`: status server bind address (default `0.0.0.0:8080`)
//! - `MM_REGION`: label shown in the terminal (e.g. `SGP1`)
//! - `MM_TICK_MS`: pause between ticks (default 400)
//! - `MM_KEEPER_KEYPAIR`: the core's keeper key (opcode 64); enables funding,
//!   liquidation and commits. `MM_COMMIT_EVERY_S` (default 120) and
//!   `MM_FUNDING_EVERY_S` (default 3600) pace them.
//! - `STOCKSTREAM_DEPLOYMENT`: deployment JSON path (default: the one compiled in)

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::{http::header, response::IntoResponse, routing::get, Router};
use serde_json::Value;
use stockstream_market_maker::keeper::Keeper;
use stockstream_market_maker::maker::{Maker, Status};
use stockstream_market_maker::solana::{b58, pubkey, Keypair};
use stockstream_market_maker::v3::Bundle;
use tokio::sync::Mutex;

const BUILT_IN_DEPLOYMENT: &str = include_str!("../../../config/stockstream-deployment.json");
const DEFAULT_MARKET_API: &str = "https://stockstream-market-api.ansht.workers.dev";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn keypair(name: &str) -> Result<Keypair> {
    let path = env(name).ok_or_else(|| anyhow!("{name} must point at a keypair JSON file"))?;
    Keypair::from_json(&std::fs::read_to_string(&path).with_context(|| format!("reading {path}"))?)
}

async fn status(state: Arc<Mutex<Status>>) -> impl IntoResponse {
    let body = serde_json::to_string(&*state.lock().await).unwrap_or_else(|_| "{}".into());
    ([(header::CONTENT_TYPE, "application/json"), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "no-store")], body)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();

    let deployment: Value = serde_json::from_str(&match env("STOCKSTREAM_DEPLOYMENT") {
        Some(path) => std::fs::read_to_string(path)?,
        None => BUILT_IN_DEPLOYMENT.to_string(),
    })?;
    let field = |path: &[&str]| -> Result<String> {
        path.iter().try_fold(&deployment, |node, key| node.get(*key)).and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("deployment is missing {}", path.join(".")))
    };
    let bundle = Bundle::derive(pubkey(&field(&["programId"])?)?, pubkey(&field(&["core"])?)?, pubkey(&field(&["oracleSnapshot"])?)?);
    let rpc_url = env("MAGICBLOCK_RPC_URL").map_or_else(|| field(&["magicBlock", "rpc"]), Ok)?;
    let market_api = env("MARKET_API_URL").or_else(|| Some(DEFAULT_MARKET_API.to_string()));
    let tick = Duration::from_millis(env("MM_TICK_MS").and_then(|v| v.parse().ok()).unwrap_or(400));

    let maker = Arc::new(Maker::new(&rpc_url, market_api, bundle.clone(), keypair("MM_MAKER_KEYPAIR")?, keypair("MM_TAKER_KEYPAIR")?, env("MM_REGION")).await?);
    let (maker_seat, taker_seat) = maker.seats();
    tracing::info!(core = %b58(&bundle.core), rpc = %rpc_url, maker_seat, taker_seat, "market maker starting");

    let keeper = match env("MM_KEEPER_KEYPAIR") {
        Some(_) => {
            let seconds = |name: &str, default: u64| Duration::from_secs(env(name).and_then(|v| v.parse().ok()).unwrap_or(default));
            let keeper = Keeper::new(&rpc_url, bundle.clone(), keypair("MM_KEEPER_KEYPAIR")?, maker.status.clone(), maker.paused.clone(), seconds("MM_COMMIT_EVERY_S", 120), seconds("MM_FUNDING_EVERY_S", 3_600))?;
            tracing::info!(keeper = %b58(&keeper.pubkey()), "keeper enabled");
            Some(Arc::new(keeper))
        }
        None => None,
    };
    let keeping = async {
        match keeper {
            Some(keeper) => keeper.run().await,
            None => std::future::pending().await,
        }
    };

    let state = maker.status.clone();
    let app = Router::new()
        .route("/v1/mm/status", get({ let state = state.clone(); move || status(state.clone()) }))
        .route("/status", get({ let state = state.clone(); move || status(state.clone()) }))
        .route("/healthz", get(|| async { "ok" }));
    let addr = env("MM_STATUS_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("binding {addr}"))?;
    tracing::info!("status on http://{addr}/v1/mm/status");

    // systemd and `docker stop` send SIGTERM; a terminal sends SIGINT.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = axum::serve(listener, app) => result?,
        () = maker.run(tick) => {}
        () = keeping => {}
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupted; quotes expire on their own within 60 s"),
        _ = terminate.recv() => tracing::info!("terminated; quotes expire on their own within 60 s"),
    }
    Ok(())
}
