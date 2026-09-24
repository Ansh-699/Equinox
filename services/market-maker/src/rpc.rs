//! JSON-RPC over HTTP, plus one persistent websocket that turns
//! `signatureSubscribe` into "processed" push timestamps.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::solana::{b58, Pubkey};

#[derive(Clone)]
pub struct Rpc {
    http: reqwest::Client,
    url: String,
}

impl Rpc {
    pub fn new(url: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(32)
            .tcp_nodelay(true)
            .build()?;
        Ok(Self { http, url: url.to_string() })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body: Value = self
            .http
            .post(&self.url)
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .with_context(|| format!("{method}: request failed"))?
            .json()
            .await
            .with_context(|| format!("{method}: invalid response"))?;
        if let Some(error) = body.get("error") {
            bail!("{method}: {error}");
        }
        body.get("result").cloned().ok_or_else(|| anyhow!("{method}: no result"))
    }

    pub async fn multiple_accounts(&self, keys: &[Pubkey]) -> Result<Vec<Option<Vec<u8>>>> {
        let keys: Vec<String> = keys.iter().map(|k| b58(k)).collect();
        let result = self.call("getMultipleAccounts", json!([keys, { "encoding": "base64", "commitment": "confirmed" }])).await?;
        result["value"]
            .as_array()
            .ok_or_else(|| anyhow!("getMultipleAccounts: no value"))?
            .iter()
            .map(|account| match account["data"][0].as_str() {
                Some(data) => Ok(Some(B64.decode(data)?)),
                None => Ok(None),
            })
            .collect()
    }

    pub async fn account(&self, key: &Pubkey) -> Result<Option<Vec<u8>>> {
        Ok(self.multiple_accounts(std::slice::from_ref(key)).await?.pop().flatten())
    }

    /// One account at "processed": includes transactions whose push we just saw.
    pub async fn account_processed(&self, key: &Pubkey) -> Result<Option<Vec<u8>>> {
        let result = self.call("getAccountInfo", json!([b58(key), { "encoding": "base64", "commitment": "processed" }])).await?;
        match result["value"]["data"][0].as_str() {
            Some(data) => Ok(Some(B64.decode(data)?)),
            None => Ok(None),
        }
    }

    pub async fn latest_blockhash(&self) -> Result<[u8; 32]> {
        let result = self.call("getLatestBlockhash", json!([{ "commitment": "confirmed" }])).await?;
        let text = result["value"]["blockhash"].as_str().ok_or_else(|| anyhow!("getLatestBlockhash: no blockhash"))?;
        crate::solana::pubkey(text)
    }

    pub async fn send_transaction(&self, wire: &[u8]) -> Result<String> {
        let result = self
            .call("sendTransaction", json!([B64.encode(wire), { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }]))
            .await?;
        result.as_str().map(str::to_string).ok_or_else(|| anyhow!("sendTransaction: no signature"))
    }

    /// Plain network round trip to the RPC node.
    pub async fn ping(&self) -> Result<u64> {
        let started = Instant::now();
        self.call("getHealth", json!([])).await?;
        Ok(started.elapsed().as_millis() as u64)
    }
}

type Waiters = Arc<Mutex<HashMap<u64, oneshot::Sender<(Instant, bool)>>>>;
type Acks = Arc<Mutex<HashMap<u64, oneshot::Sender<u64>>>>;
type Sink = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>;

/// Subscribe before sending; the "processed" push stops the clock. That is
/// one network round trip plus the rollup's execution -- no polling.
pub struct SignatureSocket {
    sink: Mutex<Sink>,
    acks: Acks,
    waiters: Waiters,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
}

impl SignatureSocket {
    pub async fn connect(rpc_url: &str) -> Result<Arc<Self>> {
        let ws_url = rpc_url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
        let (stream, _) = tokio_tungstenite::connect_async(ws_url.as_str()).await.context("rollup websocket")?;
        let (sink, mut source) = stream.split();
        let acks: Acks = Arc::default();
        let waiters: Waiters = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let socket = Arc::new(Self { sink: Mutex::new(sink), acks: acks.clone(), waiters: waiters.clone(), next_id: AtomicU64::new(1), alive: alive.clone() });
        tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                let Message::Text(text) = message else { continue };
                let arrived = Instant::now();
                let Ok(body) = serde_json::from_str::<Value>(&text) else { continue };
                if let (Some(id), Some(subscription)) = (body["id"].as_u64(), body["result"].as_u64()) {
                    if let Some(ack) = acks.lock().await.remove(&id) {
                        let _ = ack.send(subscription);
                    }
                } else if body["method"] == "signatureNotification" {
                    let subscription = body["params"]["subscription"].as_u64().unwrap_or(u64::MAX);
                    let ok = body["params"]["result"]["value"]["err"].is_null();
                    if let Some(waiter) = waiters.lock().await.remove(&subscription) {
                        let _ = waiter.send((arrived, ok));
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
        });
        Ok(socket)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Resolves once subscribed; `processed` then waits for the push (or `None` after `limit`).
    pub async fn watch(&self, signature: &str) -> Result<Watch<'_>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (ack_tx, ack_rx) = oneshot::channel();
        self.acks.lock().await.insert(id, ack_tx);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": "signatureSubscribe", "params": [signature, { "commitment": "processed" }] });
        self.sink.lock().await.send(Message::Text(request.to_string().into())).await?;
        let subscription = tokio::time::timeout(Duration::from_secs(2), ack_rx)
            .await
            .map_err(|_| anyhow!("signatureSubscribe was not acknowledged"))??;
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().await.insert(subscription, tx);
        Ok(Watch { socket: self, subscription, rx })
    }
}

pub struct Watch<'a> {
    socket: &'a SignatureSocket,
    subscription: u64,
    rx: oneshot::Receiver<(Instant, bool)>,
}

impl Watch<'_> {
    pub async fn processed(self, limit: Duration) -> Option<(Instant, bool)> {
        match tokio::time::timeout(limit, self.rx).await {
            Ok(Ok(result)) => Some(result),
            _ => {
                self.socket.waiters.lock().await.remove(&self.subscription);
                None
            }
        }
    }
}
