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
//! - `STOCKSTREAM_DEPLOYMENT`: deployment JSON path (default: the one compiled in);
//!   its `markets` list names every market (the first is primary). Markets with
//!   `oracle.kind = "prestocks"` (a PreStocks token) or `"meteora"` (a graduated
//!   DAMM v2 pool, priced per `lot` tokens) get a price reporter (the keeper key reports).
//! - `SOLANA_RPC_URL`: Solana RPC for the reporter's L1 posts (default devnet)
//! - `SOLANA_SEND_URL`: where the reporter sends its posts (default the public devnet RPC)
//! - `MM_DATA_DIR`: where reporter-priced markets' candles persist (default /var/lib/stockstream)

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path, Query};
use axum::{http::header, response::IntoResponse, routing::get, Json, Router};
use stockstream_market_maker::candles::PriceHistory;
use serde_json::Value;
use stockstream_market_maker::keeper::Keeper;
use stockstream_market_maker::maker::{Maker, MarketConfig, Status};
use stockstream_market_maker::reporter::{PriceSource, Reporter};
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
    let program = pubkey(&field(&["programId"])?)?;
    // (market, where its price comes from when this service reports it)
    let markets: Vec<(MarketConfig, Option<PriceSource>)> = match deployment.get("markets").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .enumerate()
            .map(|(index, market)| {
                let text = |key: &str| market[key].as_str().ok_or_else(|| anyhow!("market {index} is missing {key}"));
                let oracle = &market["oracle"];
                let token = match oracle["kind"].as_str() {
                    Some("prestocks") => oracle["token"].as_str().map(|token| PriceSource::PreStocks { token: token.to_string() }),
                    Some("meteora") => Some(PriceSource::MeteoraPool { pool: pubkey(oracle["pool"].as_str().ok_or_else(|| anyhow!("market {index}: meteora oracle needs a pool"))?)?, lot: oracle["lot"].as_f64().unwrap_or(1_000_000.0) }),
                    _ => None,
                };
                Ok((MarketConfig { symbol: text("symbol")?.to_string(), bundle: Bundle::derive(program, pubkey(text("core")?)?, pubkey(text("oracleSnapshot")?)?), reporter_priced: token.is_some(), primary: index == 0 }, token))
            })
            .collect::<Result<_>>()?,
        None => vec![(MarketConfig { symbol: "TSLA-PERP".into(), bundle: Bundle::derive(program, pubkey(&field(&["core"])?)?, pubkey(&field(&["oracleSnapshot"])?)?), reporter_priced: false, primary: true }, None)],
    };
    let rpc_url = env("MAGICBLOCK_RPC_URL").map_or_else(|| field(&["magicBlock", "rpc"]), Ok)?;
    let market_api = env("MARKET_API_URL").or_else(|| Some(DEFAULT_MARKET_API.to_string()));
    let tick = Duration::from_millis(env("MM_TICK_MS").and_then(|v| v.parse().ok()).unwrap_or(400));

    let state = Arc::new(Mutex::new(Status { colo: env("MM_REGION"), ..Status::default() }));
    let l1_url = env("SOLANA_RPC_URL").unwrap_or_else(|| "https://api.devnet.solana.com".into());
    let send_url = env("SOLANA_SEND_URL").unwrap_or_else(|| "https://api.devnet.solana.com".into());
    let mut reporters = 0u64;
    let seconds = |name: &str, default: u64| Duration::from_secs(env(name).and_then(|v| v.parse().ok()).unwrap_or(default));
    let mut jobs: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> = Vec::new();
    let prestocks = Arc::new(stockstream_market_maker::reporter::PreStocksFeed::default());
    let history = Arc::new(PriceHistory::open(Some(std::path::PathBuf::from(env("MM_DATA_DIR").unwrap_or_else(|| "/var/lib/stockstream".into())).join("candles"))));
    for (market, token) in markets {
        // A market whose bots have no seat yet still gets its reporter and keeper.
        let maker = match Maker::new(&rpc_url, market_api.clone(), market.clone(), keypair("MM_MAKER_KEYPAIR")?, keypair("MM_TAKER_KEYPAIR")?, state.clone()).await {
            Ok(maker) => {
                let maker = Arc::new(maker);
                let (maker_seat, taker_seat) = maker.seats();
                tracing::info!(market = %market.symbol, core = %b58(&market.bundle.core), maker_seat, taker_seat, "making");
                jobs.push(Box::pin(maker.clone().run(tick)));
                Some(maker)
            }
            Err(error) => {
                tracing::warn!(market = %market.symbol, "not making: {error:#}");
                None
            }
        };
        if env("MM_KEEPER_KEYPAIR").is_some() {
            let paused = maker.as_ref().map_or_else(Default::default, |m| m.paused.clone());
            let keeper = Arc::new(Keeper::new(&rpc_url, &market, keypair("MM_KEEPER_KEYPAIR")?, state.clone(), paused, seconds("MM_COMMIT_EVERY_S", 120), seconds("MM_FUNDING_EVERY_S", 3_600))?);
            tracing::info!(market = %market.symbol, keeper = %b58(&keeper.pubkey()), "keeper enabled");
            jobs.push(Box::pin(keeper.run()));
            if let Some(token) = token {
                let reporter = Arc::new(Reporter::new(&l1_url, &send_url, prestocks.clone(), history.clone(), keypair("MM_KEEPER_KEYPAIR")?, program, market.bundle.core, market.bundle.oracle_snapshot, token.clone(), market.symbol.clone(), state.clone())?);
                tracing::info!(market = %market.symbol, ?token, "reporting price");
                jobs.push(Box::pin(reporter.run(Duration::from_millis(reporters * 1_300))));
                reporters += 1;
            }
        }
    }
    let working = futures_util::future::join_all(jobs);
    let app = Router::new()
        .route("/v1/mm/status", get({ let state = state.clone(); move || status(state.clone()) }))
        .route("/status", get({ let state = state.clone(); move || status(state.clone()) }))
        .route("/healthz", get(|| async { "ok" }))
        // Candles for reporter-priced markets, in the market API's shape.
        .route("/v1/markets/{symbol}/candles", get({
            let history = history.clone();
            move |Path(symbol): Path<String>, Query(query): Query<std::collections::HashMap<String, String>>| {
                let history = history.clone();
                async move {
                    let number = |key: &str| query.get(key).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
                    let body = history.query(&symbol, query.get("resolution").map_or("5", String::as_str), number("from"), number("to")).await;
                    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "no-store")], Json(body))
                }
            }
        }));
    let addr = env("MM_STATUS_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("binding {addr}"))?;
    tracing::info!("status on http://{addr}/v1/mm/status");

    // systemd and `docker stop` send SIGTERM; a terminal sends SIGINT.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = axum::serve(listener, app) => result?,
        _ = working => {}
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupted; quotes expire on their own within 60 s"),
        _ = terminate.recv() => tracing::info!("terminated; quotes expire on their own within 60 s"),
    }
    Ok(())
}
