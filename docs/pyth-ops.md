# Pyth Pro Operations Checklist

Status: **Operational reference.** Verified against
`docs.pyth.network` on 2026-09-17 (Getting Started, Subscribe to Prices,
Payload Reference). The server-side keeper
(`lib/server/pyth-keeper.ts`) and the on-chain verification path
(`handlers::consume_oracle_update`, `docs/oracle.md`) are implemented and
unit-tested; what is missing is the live credential and feed discovery.
This checklist is the runbook for closing that gap.

## 0. Credential

- [ ] Acquire `PYTH_PRO_API_KEY` (Pro subscription / hackathon trial).
- [ ] Server-side only: the Pro key authenticates via
  `Authorization: Bearer <PRO_API_KEY>`. Pyth ToS **forbids exposing the
  key in frontend/client code** — never ship it to the browser.
- [ ] For any browser subscription, mint a short-lived JWT from the key via
  `POST /auth/token` and pass it through the WebSocket subprotocol list:
  marker `pyth-lazer-auth` immediately followed by the token (browsers
  cannot set WS headers). Equinox's current architecture consumes Pyth
  server-side (Worker keeper → signed payload → on-chain), so the JWT path
  is only needed if a direct browser feed is ever added.

## 1. Endpoints and redundancy

- [ ] Connect to **all three** streaming endpoints simultaneously
  (documented requirement, not a suggestion):
  - `wss://pyth-lazer-0.dourolabs.app/v1/stream`
  - `wss://pyth-lazer-1.dourolabs.app/v1/stream`
  - `wss://pyth-lazer-2.dourolabs.app/v1/stream`
- [ ] Rationale (verbatim from docs): during deployments a single endpoint
  will briefly go down; open connections to all three ensure continuity.
- [ ] SDK: `@pythnetwork/pyth-lazer-sdk` (`PythLazerClient.create({ token,
  webSocketPoolConfig: { urls: [all three] } })).

## 2. Feed discovery (before any subscription is hardcoded)

- [ ] Resolve the exact numeric `priceFeedId` for each required feed from
  the official Price Feed IDs page — the Stocklana Pyth bounty names:
  - `Equity.US.AAPL/USD` (underlying equity; the **risk oracle** feed)
  - `Crypto.AAPLX/USD` (xStock tokenized representation; display/basis only)
  - `Crypto.AAPLON/USD` (Ondo tokenized representation; display/basis only)
- [ ] For each resolved feed, record its documented `min_channel`
  (**per-feed channel availability is confirmed:** not every feed supports
  every channel; a feed supports its minimum channel and all slower
  channels). Record it per feed in the market registry notes — do not
  assume AAPL equity supports 50 ms.
- [ ] Feed IDs can become invalid over time (retirement/delisting); the
  discovery result must be re-checked at each demo and encoded as
  configuration, not constants.

## 3. Subscriptions (role-separated — do not merge)

Subscriptions are split by role so an invalid display feed can never
interfere with the risk feed — `ignoreInvalidFeeds` reduces that risk but
does not eliminate it (a failing endpoint or a malformed update is still a
shared failure surface). Two independent subscriptions:

**Risk subscription (authoritative):**
- Underlying equity feed(s) only (e.g., `Equity.US.AAPL/USD`).
- **Strict failure handling:** `ignoreInvalidFeeds: false` — a problem
  with a risk feed must fail loudly, never silently drop.
- `formats: ["solana"]` — signed payload for on-chain verification.
- Channel per §2's recorded `min_channel`; default `fixed_rate@200ms`.

**Analytics subscription (display/basis only):**
- Tokenized-stock feeds (AAPLx, AAPLON) and any other display feeds.
- `ignoreInvalidFeeds: true` — a delisted tokenized-stock feed must not
  interrupt the risk oracle's delivery.
- Display/basis use only; never a risk input (see §5).

### Risk-subscription payload (current, parser-exact)

The on-chain parser enforces an exact property set; the risk subscription
requests **exactly** the five the keeper already sends, in the fixed order
the payload contract fixes:
`price, exponent, confidence, marketSession, feedUpdateTimestamp`
(discriminants `0, 4, 5, 9, 12`). Any other property set is rejected by
`parse_verified_oracle` by design (`docs/oracle.md`).

Include `feedUpdateTimestamp` — mandatory for freshness: a price may be
carried forward off-hours; only `feedUpdateTimestamp` (not the envelope's
`timestampUs`) tells whether the price was generated in this update. The
on-chain path already enforces this ordering check.

### Payload expansion (pending verification — do not implement blind)

The features claimed elsewhere (halt/corporate-action risk modes, spread
validation, crossed-market rejection, bid/ask monitoring) require a wider
property set. The official Payload Reference (verified 2026-09-17) lists
`bestBidPrice` and `bestAskPrice` as requestable but **experimental**, and
lists `marketSession` — but **does not list a `tradingStatus` property**;
architecture v2 claims `TradingStatus { Open, Closed, Halted, CorpAction }`
from the protocol source. Before any expansion:

- [ ] Verify from the official Pyth protocol source
      (`pyth-network/pyth-lazer-public`, `PriceFeedProperty` enum) whether
      `tradingStatus` is a real requestable property, and record its
      discriminant.
- [ ] Then expand the risk subscription to the verified equivalent of:
      `price, bestBidPrice, bestAskPrice, exponent, confidence,
      feedUpdateTimestamp, marketSession, tradingStatus`.
- [ ] Re-derive the expected TLV encoding **from the official source** —
      the current hardcoded 53-byte expectation is valid only for the
      five-property set and must be replaced by a source-derived constant
      for any wider set.
- [ ] Update in lockstep: Rust payload parser, expected TLV length,
      property-order validation, Pyth instruction construction, Worker
      subscription, TypeScript decoder, golden vectors, oracle events,
      and market-mode mapping.

Bid/ask usage rule: best bid/ask enable spread validation, mid-price
 display, crossed-market rejection, and richer hedge-review warnings —
 they are **never** automatically the liquidation price; the configured
 index-price policy remains authoritative.

**Channel:** default `fixed_rate@200ms`. Upgrade to `fixed_rate@50ms` (or
`real_time`) only after §2 confirms the feed's entitlement.
`fixed_rate@1ms` exists but is not a target.

## 4. Verification chain (existing, re-verify live)

- [ ] Keeper requests the five-property payload, constructs Ed25519
  verification instructions + `ConsumeOracleUpdate`, submits through the
  L1 transport; on-chain checks include: Ed25519 instruction position,
  Pyth program/storage/treasury identity, payload length (53 bytes for the
  five-property set), feed identity, exponent range, confidence bounds,
  `feedUpdateTimestamp` freshness/monotonicity, feed-vs-envelope timestamp
  ordering, and `MarketSession` → `MarketMode` mapping
  (`Regular/PreMarket/PostMarket/OverNight/Closed`).
- [ ] Verified live endpoints for the CPI target (Solana devnet):
  program `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`, storage
  `3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL`, treasury
  `Gx4MBPb1vqZLajZmsKLg8fGw9ErhoKsR8LeKcCKFyak`
  (`docs/devnet-configuration.md`). Re-confirm these addresses against the
  live Pyth deployment before the demo — they are deployment facts, not
  protocol constants.
- [ ] First live acceptance test: one real signed update accepted by
  `consume_oracle_update` on devnet, emitting `OracleUpdated` (and
  `MarketSessionChanged` on a mode transition) with correct event sequences.

## 5. Dual-feed roles (protocol rule)

- **Risk authority:** the underlying equity feed only (e.g.,
  `Equity.US.AAPL/USD`). Changing the risk feed requires deliberate
  protocol-level approval — never automatic.
- **Display/analytics:** tokenized-stock feeds (AAPLx, AAPLON) power the
  basis panel, tracking-error display, hedge sizing context, divergence
  warnings, and market-hours explanation.
- **Never:** tokenized-stock feed prices as liquidation, mark, funding, or
  collateral valuation inputs; PreStocks/Tessera API prices as oracles;
  reserve-attestation data as a market-price oracle.

## 5a. Session AND trading status (two distinct fields)

`MarketSession` identifies the session; it **cannot substitute for**
`TradingStatus`. A feed can be in `Regular` session while trading is
`Halted`, and off-hours carry-forward needs `feedUpdateTimestamp` to
distinguish stale from fresh. Precedence for mode mapping (protocol-level,
`TradingStatus` overrides the session mapping where they conflict):

```
TradingStatus::Halted              → Halted or ReduceOnly
TradingStatus::CorpAction          → CorporateAction / no new exposure
TradingStatus::Closed              → Closed or ReduceOnly per policy
TradingStatus::Open + Session::Regular            → Normal
TradingStatus::Open + PreMarket / PostMarket / OverNight
                                   → Extended or ReduceOnly per policy
```

Until the payload expansion (§3) verifies and ships `tradingStatus`, the
on-chain program cannot distinguish halt/corporate-action from a routine
closed session — this is a known capability gap, not a solved feature.

## 5b. Equity-market calendar limitations (operational handling still required)

Pyth session/status fields are authoritative **when present**, but
Equinox still needs operational handling for: exchange holidays, early
closes, feed carry-forward, daylight-saving transitions, corporate
actions, and feed retirement. The Worker market-session/holiday keeper
(`sessionTransitionFor`) works from *configured* calendars — it must
**never override** a signed `Halted` or `CorpAction` status from the
verified feed; the signed status wins.

## 5c. Multi-endpoint disagreement handling

Three endpoints are mandatory redundancy; that introduces conflict risk.
The risk path must:

- Deduplicate updates by (feed ID, signed-payload identity, update
  timestamp).
- Reject timestamp regression (never submit an older signed update than
  the last accepted one — the on-chain monotonicity check enforces this
  too, but do not rely on rejection as the dedup mechanism).
- If two endpoints deliver **different** payloads for the same
  feed/timestamp: quarantine both, alert, and submit nothing until
  resolved.
- Track per-endpoint latency and error rates (feeds the latency HUD and
  `GET /v1/health/keepers`).
- **Never submit the same signed update multiple times** — the keeper's
  durable `(timestamp, payload hash)` dedup already guards this; keep it
  authoritative.

## 6. Session/freshness behavior to demonstrate

- [ ] Off-hours carry-forward: show `feedUpdateTimestamp < timestampUs`
  and the venue's close-only/extended mode mapping.
- [ ] Stale-feed safety: keeper withholds new exposure decisions when
  freshness checks fail; pegged orders suspend (Skipped state) rather than
  silently cancel.
- [ ] Halt/corporate-action status visibly changes the market mode and
  blocks risk-increasing orders.

## 7. Failure drills (pre-demo)

- [ ] Kill one of the three WS endpoints → subscription continues on the
  survivors.
- [ ] Expire/rotate the API key → keeper fails safe (no new exposure on
  unverified oracle), recovers on re-auth.
- [ ] Subscribe with one deliberately invalid feed ID and
  `ignoreInvalidFeeds: true` → valid feeds continue, drop is reported.
- [ ] Simulate carried-forward price → venue enters the documented
  reduced/extended mode, never treats the stale price as fresh.
