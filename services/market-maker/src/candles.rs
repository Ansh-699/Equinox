//! Price history for reporter-priced markets (no Pyth history exists for a
//! private company): 1-minute candles built from the reporter's posts, kept in
//! memory, appended to `<dir>/<SYMBOL>.jsonl` as each minute closes, and served
//! in the same TradingView-style shape as the market API (`{s,t,o,h,l,c}`).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candle {
    pub t: u64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
}

/// ~180 days of minutes per market.
const MAX_MINUTES: usize = 180 * 24 * 60;

pub struct PriceHistory {
    dir: Option<PathBuf>,
    minutes: Mutex<BTreeMap<String, Vec<Candle>>>,
}

/// Seconds per bucket for a market-API resolution code.
pub fn resolution_seconds(code: &str) -> Option<u64> {
    match code {
        "1" => Some(60),
        "5" => Some(300),
        "15" => Some(900),
        "60" => Some(3_600),
        "240" => Some(14_400),
        "D" | "1D" => Some(86_400),
        _ => None,
    }
}

/// Rolls 1-minute candles into `seconds`-wide buckets within [from, to].
pub fn aggregate(minutes: &[Candle], seconds: u64, from: u64, to: u64) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    for m in minutes.iter().filter(|m| m.t >= from.saturating_sub(seconds) && m.t <= to) {
        let bucket = m.t - m.t % seconds;
        match out.last_mut() {
            Some(last) if last.t == bucket => {
                last.h = last.h.max(m.h);
                last.l = last.l.min(m.l);
                last.c = m.c;
            }
            _ => out.push(Candle { t: bucket, ..*m }),
        }
    }
    out.retain(|c| c.t + seconds > from);
    out
}

impl PriceHistory {
    /// Loads any saved minutes from `dir` (created if missing).
    pub fn open(dir: Option<PathBuf>) -> Self {
        let mut minutes = BTreeMap::new();
        if let Some(dir) = &dir {
            let _ = std::fs::create_dir_all(dir);
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                let (Some(symbol), Some("jsonl")) = (path.file_stem().and_then(|s| s.to_str()), path.extension().and_then(|e| e.to_str())) else { continue };
                let list: Vec<Candle> = std::fs::read_to_string(&path)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str::<[f64; 5]>(line).ok())
                    .map(|[t, o, h, l, c]| Candle { t: t as u64, o, h, l, c })
                    .collect();
                minutes.insert(symbol.to_string(), list);
            }
        }
        Self { dir, minutes: Mutex::new(minutes) }
    }

    /// Adds one price observation at unix second `at`.
    pub async fn record(&self, symbol: &str, at: u64, price: f64) {
        let minute = at - at % 60;
        let mut all = self.minutes.lock().await;
        let list = all.entry(symbol.to_string()).or_default();
        match list.last_mut() {
            Some(last) if last.t == minute => {
                last.h = last.h.max(price);
                last.l = last.l.min(price);
                last.c = price;
            }
            Some(last) if last.t > minute => {} // out of order: ignore
            previous => {
                // The previous minute just closed: persist it.
                if let (Some(closed), Some(dir)) = (previous.copied(), &self.dir) {
                    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{symbol}.jsonl"))) {
                        let _ = writeln!(file, "[{},{},{},{},{}]", closed.t, closed.o, closed.h, closed.l, closed.c);
                    }
                }
                list.push(Candle { t: minute, o: price, h: price, l: price, c: price });
                if list.len() > MAX_MINUTES {
                    list.drain(..list.len() - MAX_MINUTES);
                }
            }
        }
    }

    /// The market-API response for `symbol`.
    pub async fn query(&self, symbol: &str, resolution: &str, from: u64, to: u64) -> Value {
        let Some(seconds) = resolution_seconds(resolution) else { return json!({ "s": "error", "errmsg": "invalid candle query" }) };
        let all = self.minutes.lock().await;
        let candles = all.get(symbol).map(|list| aggregate(list, seconds, from, to)).unwrap_or_default();
        if candles.is_empty() {
            return json!({ "s": "no_data" });
        }
        json!({
            "s": "ok",
            "t": candles.iter().map(|c| c.t).collect::<Vec<_>>(),
            "o": candles.iter().map(|c| c.o).collect::<Vec<_>>(),
            "h": candles.iter().map(|c| c.h).collect::<Vec<_>>(),
            "l": candles.iter().map(|c| c.l).collect::<Vec<_>>(),
            "c": candles.iter().map(|c| c.c).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minute(t: u64, o: f64, h: f64, l: f64, c: f64) -> Candle {
        Candle { t, o, h, l, c }
    }

    #[test]
    fn minutes_roll_up_into_wider_buckets() {
        let minutes = [minute(0, 10.0, 12.0, 9.0, 11.0), minute(60, 11.0, 15.0, 10.0, 14.0), minute(300, 14.0, 14.0, 13.0, 13.5)];
        assert_eq!(aggregate(&minutes, 300, 0, 600), vec![minute(0, 10.0, 15.0, 9.0, 14.0), minute(300, 14.0, 14.0, 13.0, 13.5)]);
        assert_eq!(aggregate(&minutes, 60, 60, 60), vec![minute(60, 11.0, 15.0, 10.0, 14.0)]);
    }

    #[tokio::test]
    async fn observations_build_minutes_and_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("stockstream-candles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let history = PriceHistory::open(Some(dir.clone()));
        for (at, price) in [(0, 10.0), (30, 12.0), (59, 11.0), (61, 13.0)] {
            history.record("OPENAI-PERP", at, price).await;
        }
        let reopened = PriceHistory::open(Some(dir.clone()));
        assert_eq!(reopened.query("OPENAI-PERP", "1", 0, 0).await["c"][0], 11.0); // closed minute persisted
        assert_eq!(history.query("OPENAI-PERP", "5", 0, 120).await["h"][0], 13.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
