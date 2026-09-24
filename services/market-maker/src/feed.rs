//! When a change becomes visible to everyone watching a market: one websocket
//! `accountSubscribe` to the market core (every order changes it), recording
//! when each update arrives and for which slot. A transaction is visible once
//! an update for its slot (or later) has been pushed.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::solana::{b58, Pubkey};

const KEEP: usize = 1_024;

#[derive(Default)]
pub struct SlotFeed {
    seen: Mutex<VecDeque<(Instant, u64)>>,
}

impl SlotFeed {
    /// Subscribes (and resubscribes after any drop) to `account` on the rollup.
    pub fn spawn(rpc_url: &str, account: Pubkey) -> Arc<Self> {
        Self::spawn_with(rpc_url, json!({ "jsonrpc": "2.0", "id": 1, "method": "accountSubscribe", "params": [b58(&account), { "encoding": "base64", "commitment": "processed" }] }))
    }

    /// The rollup's slot clock: each new slot as it starts. Slot S+1 starting
    /// means the block for slot S has been produced.
    pub fn spawn_slots(rpc_url: &str) -> Arc<Self> {
        Self::spawn_with(rpc_url, json!({ "jsonrpc": "2.0", "id": 1, "method": "slotSubscribe" }))
    }

    fn spawn_with(rpc_url: &str, subscribe: Value) -> Arc<Self> {
        let feed = Arc::new(Self::default());
        let ws_url = rpc_url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
        let task = feed.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = tokio_tungstenite::connect_async_with_config(ws_url.as_str(), None, true).await {
                    let (mut sink, mut source) = stream.split();
                    if sink.send(Message::Text(subscribe.to_string().into())).await.is_ok() {
                        while let Some(Ok(message)) = source.next().await {
                            let Message::Text(text) = message else { continue };
                            let arrived = Instant::now();
                            let Ok(body) = serde_json::from_str::<Value>(&text) else { continue };
                            // accountNotification: result.context.slot; slotNotification: result.slot.
                            let result = &body["params"]["result"];
                            if let Some(slot) = result["context"]["slot"].as_u64().or_else(|| result["slot"].as_u64()) {
                                task.record(arrived, slot).await;
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        feed
    }

    async fn record(&self, at: Instant, slot: u64) {
        let mut seen = self.seen.lock().await;
        seen.push_back((at, slot));
        if seen.len() > KEEP {
            seen.pop_front();
        }
    }

    /// First update for `slot` or later that arrived after `since`, waiting up to `limit`.
    pub async fn visible(&self, slot: u64, since: Instant, limit: Duration) -> Option<Instant> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(at) = self.seen.lock().await.iter().find(|(at, s)| *s >= slot && *at >= since).map(|(at, _)| *at) {
                return Some(at);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_transaction_is_visible_at_the_first_update_for_its_slot() {
        let feed = SlotFeed::default();
        let start = Instant::now();
        feed.record(start + Duration::from_millis(5), 99).await;
        feed.record(start + Duration::from_millis(40), 100).await;
        feed.record(start + Duration::from_millis(60), 101).await;
        assert_eq!(feed.visible(100, start, Duration::ZERO).await, Some(start + Duration::from_millis(40)));
        assert_eq!(feed.visible(102, start, Duration::ZERO).await, None);
    }
}
