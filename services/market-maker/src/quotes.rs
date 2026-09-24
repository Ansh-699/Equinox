//! Quote ladder and the Binance-style incremental requote plan.

use rand::Rng;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    pub fn label(self) -> &'static str {
        match self { Side::Bid => "bid", Side::Ask => "ask" }
    }
}

/// Ten rungs a side: 1 bp at the touch (≈2 bp spread), ≈0.23% deep.
pub const LADDER_BPS: [i128; 10] = [1, 2, 3, 4, 6, 8, 11, 14, 18, 23];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub side: Side,
    pub price: i64,
    pub quantity: u64,
    pub rung: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestingOrder {
    pub key: u128,
    pub side: Side,
    pub price: i64,
    pub quantity: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuoteAction {
    Place(Quote),
    Replace(u128, Quote),
    Cancel(u128),
}

/// Share-count scale (percent) that rests about the same dollar depth as TSLA
/// (~$376) at any price: 100 for TSLA-priced shares, down to 10 for dear ones.
pub fn size_scale(index: i64) -> u64 {
    (37_600_000i128 * 100 / i128::from(index.max(1))).clamp(10, 100) as u64
}

/// Post-only ladder around `index`, shifted against inventory so the maker mean-reverts.
pub fn ladder(index: i64, inventory: i128, rng: &mut impl Rng) -> Vec<Quote> {
    let scale = size_scale(index);
    let index = i128::from(index);
    let skew = index * inventory / 400_000;
    LADDER_BPS
        .iter()
        .enumerate()
        .flat_map(|(rung, bps)| {
            let offset = index * bps / 10_000;
            let quantity = ((2 + rung as u64 * 3 + rng.gen_range(0..4u64)) * scale + 50) / 100; // deeper rungs rest more size
            let quantity = quantity.max(1);
            [Side::Bid, Side::Ask].map(|side| Quote {
                side,
                rung,
                quantity,
                price: ((if side == Side::Bid { index - offset } else { index + offset }) - skew) as i64,
            })
        })
        .collect()
}

/// Touch first: highest bid, lowest ask.
fn by_priority(side: Side, a: i64, b: i64) -> std::cmp::Ordering {
    if side == Side::Bid { b.cmp(&a) } else { a.cmp(&b) }
}

/// Pair each target rung with the maker's resting order of the same rank and
/// only touch what drifted: a rung is kept while it sits within tolerance
/// (0.2 bp at the touch … 2 bp deep) and is not about to expire; drifted rungs
/// are replaced atomically (never an empty level), missing ones placed, extras
/// and expired leftovers cancelled.
pub fn plan_quotes(resting: &[RestingOrder], targets: &[Quote], index: i64, now: u64) -> Vec<QuoteAction> {
    const REFRESH_BEFORE_S: u64 = 12;
    let mut actions = Vec::new();
    for side in [Side::Bid, Side::Ask] {
        let mut live: Vec<_> = resting.iter().filter(|o| o.side == side && o.expires_at > now).collect();
        live.sort_by(|a, b| by_priority(side, a.price, b.price));
        let mut wanted: Vec<_> = targets.iter().filter(|q| q.side == side).collect();
        wanted.sort_by(|a, b| by_priority(side, a.price, b.price));
        for (rank, quote) in wanted.iter().enumerate() {
            match live.get(rank) {
                None => actions.push(QuoteAction::Place((*quote).clone())),
                Some(order) => {
                    let tolerance = i128::from(index) * (2 + quote.rung as i128 * 2) / 100_000;
                    let drift = (i128::from(order.price) - i128::from(quote.price)).abs();
                    if drift > tolerance || order.expires_at - now < REFRESH_BEFORE_S {
                        actions.push(QuoteAction::Replace(order.key, (*quote).clone()));
                    }
                }
            }
        }
        actions.extend(live.iter().skip(wanted.len()).map(|order| QuoteAction::Cancel(order.key)));
    }
    actions.extend(resting.iter().filter(|o| o.expires_at <= now).map(|o| QuoteAction::Cancel(o.key)));
    actions
}

/// Like other traders joining and leaving: re-size `count` settled rungs in place.
pub fn jitter(resting: &[RestingOrder], targets: &[Quote], actions: &mut Vec<QuoteAction>, now: u64, count: usize, max_actions: usize, rng: &mut impl Rng) {
    let touched = |actions: &[QuoteAction], side: Side, rung: usize| {
        actions.iter().any(|a| matches!(a, QuoteAction::Place(q) | QuoteAction::Replace(_, q) if q.side == side && q.rung == rung))
    };
    for _ in 0..count {
        if actions.len() >= max_actions {
            return;
        }
        let side = if rng.gen_bool(0.5) { Side::Bid } else { Side::Ask };
        let mut live: Vec<_> = resting.iter().filter(|o| o.side == side && o.expires_at > now).collect();
        live.sort_by(|a, b| by_priority(side, a.price, b.price));
        let span = live.len().min(targets.len() / 2);
        if span == 0 {
            continue;
        }
        let rung = rng.gen_range(0..span);
        let Some(quote) = targets.iter().find(|q| q.side == side && q.rung == rung) else { continue };
        if touched(actions, side, rung) {
            continue;
        }
        let quantity = quote.quantity + rng.gen_range(0..6u64);
        actions.push(QuoteAction::Replace(live[rung].key, Quote { price: live[rung].price, quantity, ..quote.clone() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::mock::StepRng;

    const INDEX: i64 = 38_000_000;
    const NOW: u64 = 1_000;

    fn fixed() -> StepRng {
        StepRng::new(0, 0)
    }
    fn as_resting(quotes: &[Quote]) -> Vec<RestingOrder> {
        quotes.iter().enumerate().map(|(i, q)| RestingOrder { key: i as u128 + 1, side: q.side, price: q.price, quantity: q.quantity, expires_at: NOW + 60 }).collect()
    }

    #[test]
    fn dear_shares_rest_about_the_same_dollar_depth() {
        assert_eq!(size_scale(37_600_000), 100);
        let openai = 137_974_000; // $1,379.74
        assert_eq!(size_scale(openai), 27);
        let depth = |index: i64| ladder(index, 0, &mut fixed()).iter().map(|q| q.quantity as i128 * i128::from(index)).sum::<i128>();
        let (tsla, dear) = (depth(37_600_000), depth(openai));
        assert!((dear - tsla).abs() * 10 < tsla, "within 10%: {tsla} vs {dear}");
    }

    #[test]
    fn ladder_is_symmetric_when_flat_and_skews_against_inventory() {
        let flat = ladder(INDEX, 0, &mut fixed());
        assert_eq!(flat.len(), 20);
        let touch = (i128::from(INDEX) * LADDER_BPS[0] / 10_000) as i64;
        assert_eq!(flat[0], Quote { side: Side::Bid, price: INDEX - touch, quantity: 2, rung: 0 });
        assert_eq!(flat[1], Quote { side: Side::Ask, price: INDEX + touch, quantity: 2, rung: 0 });
        assert!(flat.iter().all(|q| if q.side == Side::Bid { q.price < INDEX } else { q.price > INDEX }));
        let long = ladder(INDEX, 100, &mut fixed());
        assert!(long.iter().zip(&flat).all(|(l, f)| l.price < f.price));
    }

    #[test]
    fn fresh_book_places_every_rung_and_matching_book_does_nothing() {
        let targets = ladder(INDEX, 0, &mut fixed());
        assert!(plan_quotes(&[], &targets, INDEX, NOW).iter().all(|a| matches!(a, QuoteAction::Place(_))));
        assert!(plan_quotes(&as_resting(&targets), &targets, INDEX, NOW).is_empty());
    }

    #[test]
    fn small_move_only_replaces_the_touch_never_wipes() {
        let targets = ladder(INDEX, 0, &mut fixed());
        let actions = plan_quotes(&as_resting(&targets), &ladder(INDEX + 3_000, 0, &mut fixed()), INDEX, NOW);
        assert!(!actions.is_empty() && actions.len() < targets.len());
        assert!(actions.iter().all(|a| matches!(a, QuoteAction::Replace(..))));
    }

    #[test]
    fn replaces_expiring_and_cancels_extras_and_expired() {
        let targets = ladder(INDEX, 0, &mut fixed());
        let mut resting = as_resting(&targets);
        resting[0].expires_at = NOW + 5;
        resting.push(RestingOrder { key: 99, side: Side::Bid, price: 1, quantity: 1, expires_at: NOW + 60 });
        resting.push(RestingOrder { key: 100, side: Side::Ask, price: 1, quantity: 1, expires_at: NOW - 1 });
        let actions = plan_quotes(&resting, &targets, INDEX, NOW);
        assert!(actions.iter().any(|a| matches!(a, QuoteAction::Replace(1, _))));
        assert!(actions.contains(&QuoteAction::Cancel(99)));
        assert!(actions.contains(&QuoteAction::Cancel(100)));
    }

    #[test]
    fn jitter_resizes_in_place_without_moving_price() {
        let targets = ladder(INDEX, 0, &mut fixed());
        let resting = as_resting(&targets);
        let mut actions = vec![];
        jitter(&resting, &targets, &mut actions, NOW, 2, 12, &mut rand::thread_rng());
        for action in &actions {
            let QuoteAction::Replace(key, quote) = action else { panic!("jitter only replaces") };
            let order = resting.iter().find(|o| o.key == *key).unwrap();
            assert_eq!(order.price, quote.price);
        }
    }
}
