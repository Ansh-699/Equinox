//! One tick, forever: read the maker's own orders from the rollup book,
//! requote only what drifted (atomic ReplaceOrder, so a level is never
//! empty), re-size a couple of settled rungs, and let a taker seat cross the
//! touch with small IOC orders so real fills print. Every transaction is
//! timed from send to the rollup's "processed" push.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use futures_util::future::join_all;
use rand::Rng;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::quotes::{jitter, ladder, plan_quotes, QuoteAction, Side};
use crate::rpc::{Rpc, SignatureSocket};
use crate::solana::{b58, set_compute_unit_limit, sign_transaction, Instruction, Keypair};
use crate::v3::{cancel_order, place_order, replace_order, resting_orders, seat_positions, snapshot, Bundle, OrderInput};

const QUOTE_TTL_S: u64 = 60;
/// Refresh the rollup price past this age: browsers take the fast path up to 7 s.
const MAX_SNAPSHOT_AGE_S: u64 = 3;
const MAX_ACTIONS_PER_TICK: usize = 12;
const JITTER_RUNGS_PER_TICK: usize = 2;
const TAKE_EVERY_MS: (u64, u64) = (700, 2_200);
const RECENT_TXS: usize = 60;
const COMPUTE_UNITS: u32 = 600_000;
/// While the market is closed the price is refreshed this rarely, just to notice the reopen.
const CLOSED_REFRESH_EVERY_MS: u64 = 30_000;
/// Reporter-priced markets: quote while the price is younger than this (the
/// reporter posts every few seconds; orders accept up to 10 s).
const REPORTED_MAX_AGE_S: u64 = 7;

/// One market the service makes: its accounts and where its price comes from.
#[derive(Clone)]
pub struct MarketConfig {
    pub symbol: String,
    pub bundle: Bundle,
    /// Priced by this service's reporter (pre-IPO), not by Pyth through the market API.
    pub reporter_priced: bool,
    /// The market whose numbers also fill the top-level status fields (TSLA-PERP).
    pub primary: bool,
}

/// Per-market slice of the status.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketStatus {
    pub last_price: Option<f64>,
    pub resting: usize,
    pub market_open: Option<bool>,
    pub maker_seat: Option<u16>,
    pub taker_seat: Option<u16>,
    pub keeper: Option<crate::keeper::KeeperStatus>,
    pub reporter: Option<crate::reporter::ReporterStatus>,
}

/// Same JSON shape the terminal's live-transactions panel already reads.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTx {
    pub market: String,
    pub kind: &'static str,
    /// Send → the rollup's "processed" push: one network round trip plus the rollup's work.
    pub ms: Option<u64>,
    /// The plain network round trip: this tick's uncontended ping over the same HTTP
    /// connection pool the transaction is sent on (subscription acks queue behind
    /// each other in a burst, so they are not clean samples).
    pub net_ms: Option<u64>,
    /// The rollup's own share: `ms - net_ms`.
    pub er_ms: Option<u64>,
    /// How long the sendTransaction HTTP call took to return.
    pub send_ms: Option<u64>,
    /// Send → the market update carrying this transaction reached subscribers
    /// (what everyone watching the book sees).
    pub visible_ms: Option<u64>,
    /// Send → the rollup produced the block containing it (the next slot started).
    pub block_ms: Option<u64>,
    pub ok: bool,
    pub at: u64,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<u64>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub ticks: u64,
    pub quotes: u64,
    pub takes: u64,
    pub cancelled: u64,
    pub replaced: u64,
    pub errors: u64,
    pub last_tick_at: Option<u64>,
    pub last_price: Option<f64>,
    pub last_error: Option<String>,
    pub maker: Option<String>,
    pub taker: Option<String>,
    pub resting: usize,
    pub recent: Vec<ErTx>,
    /// Where the bot runs (MM_REGION), shown next to its ping in the terminal.
    pub colo: Option<String>,
    pub ping_ms: Option<u64>,
    /// Pyth trading status is OPEN; while closed the program refuses orders, so the bot waits.
    pub market_open: Option<bool>,
    /// Funding, liquidation and commit jobs of the primary market (absent without a keeper key).
    pub keeper: Option<crate::keeper::KeeperStatus>,
    /// Every market this service makes, by symbol.
    pub markets: std::collections::BTreeMap<String, MarketStatus>,
}

impl Status {
    pub fn market(&mut self, symbol: &str) -> &mut MarketStatus {
        self.markets.entry(symbol.to_string()).or_default()
    }
}

struct Bot {
    key: Keypair,
    seat: u16,
}

pub struct Maker {
    rpc: Rpc,
    rpc_url: String,
    http: reqwest::Client,
    market_api: Option<String>,
    market: MarketConfig,
    bundle: Bundle,
    maker: Bot,
    taker: Bot,
    socket: Mutex<Option<Arc<SignatureSocket>>>,
    client_order_id: Mutex<u64>,
    next_take_ms: Mutex<u64>,
    last_closed_refresh_ms: Mutex<u64>,
    pub status: Arc<Mutex<Status>>,
    /// Set by the keeper while a commit snapshot freezes trading.
    pub paused: Arc<std::sync::atomic::AtomicBool>,
    feed: Arc<crate::feed::SlotFeed>,
    slots: Arc<crate::feed::SlotFeed>,
    /// Every completed transaction, streamed to browsers.
    live: tokio::sync::broadcast::Sender<ErTx>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("clock after 1970").as_millis() as u64
}

impl Maker {
    pub async fn new(rpc_url: &str, market_api: Option<String>, market: MarketConfig, maker: Keypair, taker: Keypair, status: Arc<Mutex<Status>>, live: tokio::sync::broadcast::Sender<ErTx>) -> Result<Self> {
        let bundle = market.bundle.clone();
        let rpc = Rpc::new(rpc_url)?;
        let positions: Vec<_> = rpc
            .multiple_accounts(&bundle.seat_shards)
            .await
            .context("reading seat shards")?
            .into_iter()
            .flatten()
            .flat_map(|shard| seat_positions(&shard))
            .collect();
        let seat_of = |key: &Keypair| {
            positions.iter().find(|p| p.trader == key.pubkey()).map(|p| p.index).ok_or_else(|| anyhow!("bot {} has no seat in {}", b58(&key.pubkey()), market.symbol))
        };
        let (maker_seat, taker_seat) = (seat_of(&maker)?, seat_of(&taker)?);
        {
            let mut status = status.lock().await;
            status.running = true;
            status.maker = Some(b58(&maker.pubkey()));
            status.taker = Some(b58(&taker.pubkey()));
            let slice = status.market(&market.symbol);
            (slice.maker_seat, slice.taker_seat) = (Some(maker_seat), Some(taker_seat));
        }
        let feed = crate::feed::SlotFeed::spawn(rpc_url, bundle.core);
        Ok(Self {
            rpc,
            rpc_url: rpc_url.to_string(),
            http: reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?,
            market_api,
            market,
            bundle,
            maker: Bot { key: maker, seat: maker_seat },
            taker: Bot { key: taker, seat: taker_seat },
            socket: Mutex::new(None),
            client_order_id: Mutex::new(now_ms() * 1_000),
            next_take_ms: Mutex::new(0),
            last_closed_refresh_ms: Mutex::new(0),
            status,
            paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            feed,
            slots: crate::feed::SlotFeed::spawn_slots(rpc_url),
            live,
        })
    }

    pub fn seats(&self) -> (u16, u16) {
        (self.maker.seat, self.taker.seat)
    }

    pub async fn run(self: Arc<Self>, tick_every: Duration) {
        loop {
            if self.paused.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(tick_every).await;
                continue;
            }
            let result = self.tick().await;
            let mut status = self.status.lock().await;
            status.ticks += 1;
            status.last_tick_at = Some(now_ms());
            match result {
                Ok(()) => status.last_error = None,
                Err(error) => {
                    status.errors += 1;
                    status.last_error = Some(format!("{error:#}").chars().take(300).collect());
                    tracing::warn!("tick failed: {error:#}");
                }
            }
            drop(status);
            tokio::time::sleep(tick_every).await;
        }
    }

    async fn socket(&self) -> Result<Arc<SignatureSocket>> {
        let mut slot = self.socket.lock().await;
        if let Some(socket) = slot.as_ref().filter(|s| s.is_alive()) {
            return Ok(socket.clone());
        }
        let socket = SignatureSocket::connect(&self.rpc_url).await?;
        *slot = Some(socket.clone());
        Ok(socket)
    }

    async fn next_client_order_id(&self) -> u64 {
        let mut id = self.client_order_id.lock().await;
        *id += 1;
        *id
    }

    /// Signed and subscribed before the clock starts: the time is network + rollup, nothing else.
    #[allow(clippy::too_many_arguments)]
    async fn submit(&self, socket: &SignatureSocket, kind: &'static str, bot: &Bot, ix: Instruction, blockhash: &[u8; 32], net_ms: Option<u64>, detail: Option<(Side, i64, u64)>) -> Option<ErTx> {
        let (wire, signature) = sign_transaction(&bot.key, &[set_compute_unit_limit(COMPUTE_UNITS), ix], blockhash).ok()?;
        let signature = b58(&signature);
        let watch = socket.watch(&signature).await.ok();
        let at = now_ms();
        let started = Instant::now();
        self.rpc.send_transaction(&wire).await.ok()?; // a rejected quote is re-planned next tick
        let send_ms = Some(started.elapsed().as_millis() as u64);
        // First of: the websocket push, or an HTTP status poll. Pushes after a quiet
        // spell can reach us ~40 ms after the rollup already reports the transaction
        // processed; the poll shows when it really was.
        let pushed = async {
            match watch {
                Some(watch) => watch.processed(Duration::from_secs(3)).await,
                None => std::future::pending().await,
            }
        };
        let polled = async { self.rpc.poll_processed(&signature, Duration::from_secs(3)).await.map(|(ok, slot)| (Instant::now(), ok, slot)) };
        let processed = tokio::select! { p = pushed => p, p = polled => p };
        let ms = processed.map(|(arrived, _, _)| arrived.saturating_duration_since(started).as_millis() as u64);
        // Visible to everyone: the first market update for this slot pushed to subscribers.
        let visible_ms = match processed {
            Some((_, true, slot)) if slot > 0 => self.feed.visible(slot, started, Duration::from_secs(1)).await.map(|at| at.saturating_duration_since(started).as_millis() as u64),
            _ => None,
        };
        // On chain: the block holding this slot is produced once the next slot starts.
        let block_ms = match processed {
            Some((_, true, slot)) if slot > 0 => self.slots.visible(slot + 1, started, Duration::from_secs(1)).await.map(|at| at.saturating_duration_since(started).as_millis() as u64),
            _ => None,
        };
        let tx = ErTx {
            market: self.market.symbol.clone(),
            kind,
            ms,
            net_ms,
            er_ms: ms.zip(net_ms).map(|(total, network)| total.saturating_sub(network)),
            send_ms,
            visible_ms,
            block_ms,
            ok: processed.is_some_and(|(_, ok, _)| ok),
            at,
            signature,
            side: detail.map(|d| d.0.label()),
            price: detail.map(|d| d.1 as f64 / 1e5),
            quantity: detail.map(|d| d.2),
        };
        let _ = self.live.send(tx.clone()); // streamed to browsers as it happens
        Some(tx)
    }

    async fn refresh_oracle(&self) -> Result<()> {
        let Some(api) = &self.market_api else { return Err(anyhow!("rollup price is stale and MARKET_API_URL is not set")) };
        let response = self.http.post(format!("{}/v1/oracle/refresh", api.trim_end_matches('/'))).send().await?;
        let ok = response.status().is_success();
        let body = response.text().await.unwrap_or_default();
        if !ok {
            return Err(anyhow!("oracle refresh failed: {}", body.chars().take(200).collect::<String>()));
        }
        Ok(())
    }

    async fn tick(&self) -> Result<()> {
        let ping = self.rpc.ping().await.ok();
        if let Some(ping) = ping.filter(|_| self.market.primary) {
            let mut status = self.status.lock().await;
            status.ping_ms = Some(status.ping_ms.map_or(ping, |p| (p * 4 + ping) / 5));
        }

        // Price the rollup will check the orders against.
        let raw = self.rpc.account(&self.bundle.oracle_snapshot).await?.ok_or_else(|| anyhow!("rollup has no oracle snapshot"))?;
        let snapshot = snapshot(&raw).ok_or_else(|| anyhow!("oracle snapshot too short"))?;
        let (index, published) = (snapshot.price, snapshot.published);
        let now = now_ms();
        let now_s = now / 1_000;
        {
            let mut status = self.status.lock().await;
            status.market(&self.market.symbol).market_open = Some(snapshot.open);
            if self.market.primary {
                status.market_open = Some(snapshot.open);
            }
        }
        if self.market.reporter_priced {
            // The reporter keeps this price fresh; never ask the Pyth refresh route.
            if now_s.saturating_sub(published) > REPORTED_MAX_AGE_S {
                return Ok(());
            }
        } else if !snapshot.open {
            // Outside US trading hours every order would be refused: send nothing, and
            // only occasionally ask for a fresh price so the reopen is noticed.
            let mut last = self.last_closed_refresh_ms.lock().await;
            if now.saturating_sub(*last) >= CLOSED_REFRESH_EVERY_MS {
                *last = now;
                let _ = self.refresh_oracle().await;
            }
            return Ok(());
        }
        if !self.market.reporter_priced && now_s.saturating_sub(published) > MAX_SNAPSHOT_AGE_S {
            // Permissionless refresh through the market API; quote once the rollup has the new price.
            return self.refresh_oracle().await;
        }

        let reads: Vec<_> = self.bundle.book_pages.iter().chain(&self.bundle.seat_shards).copied().collect();
        let (blockhash, accounts, socket) = tokio::join!(self.rpc.latest_blockhash(), self.rpc.multiple_accounts(&reads), self.socket());
        let (blockhash, accounts, socket) = (blockhash?, accounts?, socket?);
        let pages = self.bundle.book_pages.len();
        let resting: Vec<_> = accounts[..pages].iter().flatten().flat_map(|page| resting_orders(page, self.maker.seat)).collect();
        let positions: Vec<_> = accounts[pages..].iter().flatten().flat_map(|shard| seat_positions(shard)).collect();
        let inventory = positions.iter().find(|p| p.index == self.maker.seat).map_or(0, |p| p.base_position);
        let taker_position = positions.iter().find(|p| p.index == self.taker.seat).map_or(0, |p| p.base_position);

        let (mut actions, take) = {
            let mut rng = rand::thread_rng();
            let targets = ladder(index, inventory, &mut rng);
            let mut actions: Vec<_> = plan_quotes(&resting, &targets, index, now_s).into_iter().take(MAX_ACTIONS_PER_TICK).collect();
            jitter(&resting, &targets, &mut actions, now_s, JITTER_RUNGS_PER_TICK, MAX_ACTIONS_PER_TICK, &mut rng);
            // Lean against the taker's inventory; otherwise a coin flip.
            let side = match taker_position {
                p if p > 30 => Side::Ask,
                p if p < -30 => Side::Bid,
                _ if rng.gen_bool(0.5) => Side::Bid,
                _ => Side::Ask,
            };
            let take = (side, rng.gen_range(1..=2u64), rng.gen_range(TAKE_EVERY_MS.0..TAKE_EVERY_MS.1));
            (actions, take)
        };
        let expires_at = now_s + QUOTE_TTL_S;
        let authority = self.maker.key.pubkey();

        let mut work = Vec::new();
        let (mut quotes, mut replaced, mut cancelled) = (0, 0, 0);
        for action in actions.drain(..) {
            let (kind, ix, detail) = match action {
                QuoteAction::Cancel(key) => {
                    cancelled += 1;
                    ("cancel", cancel_order(&self.bundle, &authority, self.maker.seat, key), None)
                }
                QuoteAction::Place(quote) => {
                    quotes += 1;
                    let order = OrderInput { seat: self.maker.seat, side: quote.side, quantity: quote.quantity, price: quote.price, expires_at, client_order_id: self.next_client_order_id().await, post_only: true, immediate_or_cancel: false };
                    ("quote", place_order(&self.bundle, &authority, &order), Some((quote.side, quote.price, quote.quantity)))
                }
                QuoteAction::Replace(key, quote) => {
                    replaced += 1;
                    let order = OrderInput { seat: self.maker.seat, side: quote.side, quantity: quote.quantity, price: quote.price, expires_at, client_order_id: self.next_client_order_id().await, post_only: true, immediate_or_cancel: false };
                    ("replace", replace_order(&self.bundle, &authority, key, &order), Some((quote.side, quote.price, quote.quantity)))
                }
            };
            work.push((kind, &self.maker, ix, detail));
        }

        let mut takes = 0;
        {
            let mut next_take = self.next_take_ms.lock().await;
            if now >= *next_take {
                let (side, quantity, wait) = take;
                let through = index * 10 / 10_000;
                let price = if side == Side::Bid { index + through } else { index - through };
                let order = OrderInput { seat: self.taker.seat, side, quantity, price, expires_at: now_s + 60, client_order_id: self.next_client_order_id().await, post_only: false, immediate_or_cancel: true };
                work.push(("take", &self.taker, place_order(&self.bundle, &self.taker.key.pubkey(), &order), Some((side, price, quantity))));
                takes = 1;
                *next_take = now + wait;
            }
        }

        let sent = join_all(work.into_iter().map(|(kind, bot, ix, detail)| self.submit(&socket, kind, bot, ix, &blockhash, ping, detail))).await;
        let mut sent: Vec<ErTx> = sent.into_iter().flatten().collect();
        sent.sort_by_key(|tx| std::cmp::Reverse(tx.at));

        let resting_now = resting.iter().filter(|o| o.expires_at > now_s).count();
        let mut status = self.status.lock().await;
        let slice = status.market(&self.market.symbol);
        (slice.last_price, slice.resting) = (Some(index as f64 / 1e5), resting_now);
        if self.market.primary {
            (status.last_price, status.resting) = (Some(index as f64 / 1e5), resting_now);
        }
        status.quotes += quotes;
        status.replaced += replaced;
        status.cancelled += cancelled;
        status.takes += takes;
        sent.extend(std::mem::take(&mut status.recent));
        sent.sort_by_key(|tx| std::cmp::Reverse(tx.at));
        sent.truncate(RECENT_TXS);
        status.recent = sent;
        Ok(())
    }
}
