# Equinox architecture (devnet, 2026-09-24)

Equinox is an on-chain exchange for equity-like assets on Solana:

1. **Trade stocks**: TSLA-PERP, a perpetual priced by Pyth.
2. **Trade pre-IPO companies**: OPENAI-, SPACEX- and ANTHROPIC-PERP, priced
   from PreStocks tokens, with one-click baskets.
3. **Launch equity-like tokens** on Meteora Dynamic Bonding Curves priced in
   dollars; a launch that graduates to a DAMM v2 pool can be listed as a
   perp priced from that pool.

Everything runs on Solana devnet with test USDC. Live: https://equinox.ansht.workers.dev

```text
                         Browser (Next.js on Cloudflare, vinext)
   Trade terminal · Pre-IPO (perps, baskets) · Launch (Meteora DBC) · Portfolio
   in-app trading key (one wallet signature, then silent) · reads the rollup directly
        |  orders, seats, withdrawals               |  deposits, launches, swaps
        v  (~110-130 ms from India)                 v
 +------------------------------+          +--------------------------------+
 | MagicBlock Ephemeral Rollup  |<-commit--| Solana devnet (L1)             |
 | devnet-as (Singapore)        |  30 min  | Equinox program (V3)       |
 | 4 delegated markets x 27 acc |          |  vaults, inbox/outbox receipts,|
 | order books, seats, events   |--clone-->|  oracle snapshots (L1-owned)   |
 +------------------------------+          | Meteora DBC / DAMM v2 pools    |
        ^         ^                        +--------------------------------+
        |         |                                 ^            ^
        |  quotes, keeper jobs          price posts |            | Pyth Lazer update
 +------------------------------------------+       |   +----------------------+
 | Market-maker service (Rust, Singapore VM)|-------+   | Market API (Worker)  |
 |  per market: maker · keeper · reporter   |           |  Pyth refresh, faucet|
 |  candles for reporter-priced markets     |---------->|  registries (D1),    |
 +------------------------------------------+  status   |  execution status    |
                                                         +----------------------+
```

## Components

### On-chain program (`programs/equinox`, pinocchio, V3 layout)

Each market is a **core** plus 26 child accounts: 18 book pages (a paged
PATRICIA tree per side), 4 seat shards (128 seats) and 4 event shards. The
whole 27-account bundle is delegated to MagicBlock, so matching, margin,
funding and liquidation run in the rollup at a few ms per transaction.

| Area | Instructions (opcode) | Notes |
|---|---|---|
| Orders | place 3, cancel 4, cancel-all 5, replace 33 | IOC, post-only, reduce-only; self-trade policy; price-time priority |
| Custody into the rollup | deposit inbox 60 (L1) → claim 61 (rollup) | USDC stays in the L1 vault; the rollup credits the seat |
| Custody out | request 62 (rollup, risk-checked) → claim 63 (L1) | pays only the seat owner's USDC account |
| Prices | Pyth update 58 (L1, Ed25519-verified) · reporter post 67 (L1) | both write the market's L1 `OracleSnapshotV3`; the rollup reads it |
| Keeper | funding 6, liquidate 7, commit 14 | market authority or its named keeper (64) |
| Admin | set keeper 64, abort snapshot 65, set price reporter 66 | authority only |

Risk rules that matter for users:
- Orders need a fresh price (≤ 10 s, session open). Pyth's `OverNight`
  session trades; `Closed` (weekends and holidays) refuses new orders.
- **Withdrawals never wait for a live price:** with none, a seat with no
  position withdraws freely, and a seat with a position is checked at the last
  authenticated price moved 25% against it.
- A **price reporter** (pre-IPO and launched tokens) may move the price by at
  most 0.5% + 0.1% per elapsed second (10% cap) per post; Pyth markets have no
  reporter and refuse its posts.
- MagicBlock sponsors 10 commits per account per delegation; beyond that the
  market core pays through the validator's magic fee vault (keeper commits and
  withdrawal requests pass it).

### Markets (deployment manifest `config/equinox-deployment.json` → `markets`)

| Market | Price source | Core |
|---|---|---|
| TSLA-PERP | Pyth `Equity.US.TSLA/USD` (feed 1435) | `9Vea9MVZ…` |
| OPENAI-PERP | PreStocks OPENAI token (feed id 4000000001, reserved) | `2QtGrh5x…` |
| SPACEX-PERP | PreStocks SPACEX token (4000000002) | `EgTMHNhR…` |
| ANTHROPIC-PERP | PreStocks ANTHROPIC token (4000000003) | `5Z4DPNgm…` |

All four share one exchange and one test-USDC mint, so a trader's USDC works
in every market. Margin is isolated per market (one seat per market).

### Market-maker service (`services/market-maker`, Rust/tokio, Azure Singapore VM)

One process, ~2 ms from the rollup. For every market in the manifest:
- **Maker**: 20 post-only rungs a side (1 bp to ~1%), sized to about the same
  dollar depth as TSLA, requoted in place; after a price jump the side moving
  away goes first (a rung that would cross the maker's own resting orders waits
  a tick); a taker seat crosses the touch.
- **Keeper**: liquidation scan every 3 s (the program's own risk code), hourly
  funding, commit to Solana every 30 min (trading pauses ~1.2 s).
- **Reporter** (reporter-priced markets): every second reads its source and
  the L1 snapshot and posts when the price is ≥ 4 s old or moved > 0.2%,
  walking big moves in within the program bound. Sources:
  - PreStocks: the token's on-chain price within ±50% of PreStocks' mark
    (one shared, rate-limited API read for all markets);
  - Meteora: a graduated DAMM v2 pool's `sqrt_price` × lot size.
- **Candles**: 1-minute candles from reporter posts, persisted under
  `/var/lib/stockstream` and served at `/v1/markets/{symbol}/candles`.
- **Status** (`/v1/mm/status`): per-market price, depth, keeper and reporter
  state; the live-transactions panel reads it.

### Market API (`workers/`, Cloudflare Worker + D1)

- `POST /v1/oracle/refresh`: verifies a Pyth Lazer update and posts it on L1 (TSLA).
- `GET /v1/markets/{symbol}/candles` (Pyth history), `/execution-status`.
- `POST /v1/faucet`: test USDC and a little SOL per wallet per day.
- `GET /v1/pre-ipo`: PreStocks tokens (proxied; no CORS on their API).
- `GET|POST /v1/launches`: registry of launches (pool must be DBC-owned).
- D1: market registry (execution status), faucet claims, launches.

### Frontend (`app/`, `features/`, Next.js via vinext on Cloudflare)

- **Trading key** (`lib/trading-key.ts`): one wallet signature derives an
  in-app key (remembered per device) that signs seats, deposits, orders,
  withdrawals, baskets and launch trades silently; withdrawals pay out to the
  user's wallet.
- **Terminal** (`/trade`, `?market=`): market picker over the manifest; the
  book, positions and open orders stream from the rollup over websocket; the
  order path is pre-warmed (delegation, blockhash, price age) so a click only
  signs and sends; every transaction shows a toast with its time and link.
- **Pre-IPO** (`/pre-ipo`): perp cards (perp price, PreStocks mark, token
  price, token vs mark), baskets (AI labs, Frontier) planned in whole shares
  and traded in parallel, and every PreStocks token.
- **Launch** (`/launch`, Pulse): three live columns (New pairs, Final stretch
  at ≥60% of the curve, Graduated to DAMM v2) with holders, top-10 and creator
  share, fees and transaction counts read from the chain; ⚡ quick buy, sell,
  graduate, perp link; creating a launch opens a side panel.

## Flows

**Order (from India):** click → sign with the trading key (local) → send to
the rollup → finalized in ~2-15 ms → push or status poll back → ~110-130 ms
end to end, almost all of it the India↔Singapore round trip.

**Pre-IPO price:** PreStocks API → reporter (VM) → `ReportPriceV3` on L1 →
the rollup's copy of the snapshot → orders and risk checks in the rollup.

**Basket:** plan legs (price, whole shares, margin) → faucet if short → per
leg in parallel: seat if missing, isolated margin top-up (inbox deposit),
IOC order → results with per-order time and links. One wallet prompt total.

**Launch → perp:** create DBC pool (USD-priced) → buys fill the curve →
graduation migrates liquidity to DAMM v2 → `scripts/list-market.sh <SYM>
<feed> meteora <damm-pool> <mint>` creates the market, names the reporter,
funds the bots, delegates, and the reporter prices it from the pool.

## Operations

| Task | Command |
|---|---|
| New pre-IPO or launch market | `scripts/list-market.sh …` (see its header; ~1.3 devnet SOL); it also registers the market with the market API, without which the terminal can't locate the book |
| Name or clear a keeper / reporter, abort a snapshot | `node scripts/v3-set-keeper.mjs …` |
| Top up a core's commit-fee lamports | automatic (the service, from the keeper key); by hand: `node scripts/v3-topup-core.mjs 1` |
| Service deploy | build `services/market-maker` in its Dockerfile on the VM, install, `systemctl restart stockstream-mm` |
| Live checks | `npx tsx scripts/e2e/{onboarding,deposit,preipo,basket,speed}.mts`, `SITE=…/launch npx tsx scripts/e2e/launch.mts` |

Balances to watch (devnet SOL): the keeper/reporter key `7JuUhGG…` (L1
posts, ~0.3 SOL/day for three reporters), the faucet key `AmHAkH…`, each
core's rollup lamports (commit fees), the authority for new markets.

## Known limits

- Undelegating a market (taking it out of the rollup) is blocked by the
  deployed MagicBlock delegation program (`RequestUndelegation` unsupported);
  not needed for trading or custody.
- No L1 escape hatch yet if the rollup were permanently down (funds stay in
  the L1 vault).
- Pre-IPO and launched-token prices come from a bounded reporter key, not a
  signed oracle network; every post is public on L1.
