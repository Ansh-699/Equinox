# Equinox status (2026-11-28)

The live state of the devnet deployment. The design is in
[`docs/architecture.md`](../architecture.md); earlier status history lives in
git (`git log -- docs/status`).

## Live on devnet

- **2026-11-26 recovery.** The market-maker host died, taking the keeper key
  `7JuUhGG…` with it. The service runs on a new Azure host in
  `southeastasia` behind `api.ansht.in`. The market authority named a new
  keeper, `WFgD69Q6KGaDPxJxMHeHazUG5Lp3G4ey9HA4gyVcgdN`, on all three cores
  (opcode 64) and as reporter on OPENAI- and ANTHROPIC-PERP (opcode 66), and
  the market API got a new Pyth Pro key. All three markets quote, the reporters
  post and the keeper commits again.

- **Program** `8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ`, deployed build
  recorded in `config/equinox-deployment.json`
  (`deployedArtifactSha256`). Rollup cost per order: replace ~90k CU, taker
  order ~53k CU.
- **Markets** (all delegated to MagicBlock `devnet-as`):
  TSLA-PERP (Pyth), OPENAI- and ANTHROPIC-PERP (PreStocks via the
  bounded reporter). Every market must also be registered with the market
  API (`scripts/preipo-market.sh` does it); otherwise the terminal cannot
  locate its book.
- **Trading**: one wallet signature derives the in-app trading key; faucet,
  margin account, deposit (inbox 60/61), orders, position close and
  withdrawal (outbox 62/63) are then signed silently.
- **Market-maker service** (Singapore VM, `services/market-maker`): 20
  post-only rungs a side per market, keeper (commits, funding, liquidation
  scans) and the PreStocks/Meteora price reporter.
- **Launchpad**: Meteora DBC curves priced in USDC, Pulse view (new, final
  stretch, graduated), graduation to DAMM v2, perp listing via
  `scripts/list-market.sh … meteora`.
- **Frontend**: the order book streams zstd-compressed account pushes from
  the rollup (~100 KB/s per terminal) and renders at most every 50 ms;
  execution status comes from the market API (placed in
  `azure:southeastasia`).

## Operating note (2026-11-28)

The devnet keeper `WFgD69Q6KGaDPxJxMHeHazUG5Lp3G4ey9HA4gyVcgdN` pays Solana
fees and tops up each market core. MagicBlock then charges commit fees from
that core. A stale price and an empty book mean this key is empty, not that
the program is broken. The same outage happened on 27 Nov and cleared as soon
as the key was funded again.

Two different clocks:

- The program refuses a price older than 10 seconds (`V3_MAX_ORACLE_AGE_SECONDS`).
  OPENAI and ANTHROPIC are posted by the reporter and stay inside that window.
  TSLA uses Pyth. On a weekend Pyth's last print is the Friday close, the
  program rejects it, and the book stays empty until the US session reopens.
  That is the market calendar, not a failed keeper.
- MagicBlock auto-commits every delegated market every 30 seconds. That
  interval is `commit_frequency_ms` on the delegation and is not
  `MM_COMMIT_EVERY_S`. The keeper's own snapshot commit is separate and is
  set to 1800 seconds in `/etc/stockstream/mm.env`. Slowing that variable does
  not cut the burn, and it must not be pushed out toward the 10 second price
  rule, because it does not refresh the price.

Measured on 28 Nov at 14:16 UTC: the keeper held 5.80 SOL. Each core
received 0.3 SOL roughly every 5.5 hours (about 3.9 SOL/day for three
markets) plus about 0.28 SOL/day in transaction fees. At that rate the
balance lasts about 33 hours, until about 23:30 UTC on 29 Nov (early
morning 30 Nov IST). It covers the 29 Nov submission session and the
closing ceremony. It does not cover judging that runs into 30 Nov.

Fund the keeper with devnet SOL before judging runs past 30 Nov. Do not
change `MM_COMMIT_EVERY_S` to save SOL.

- **Latency, measured (2026-11-28).** 554 market-maker transactions sampled from
  `/v1/mm/stream` over 100 s, from a bot about 2 ms from the rollup: send to the
  rollup's "processed" push p50 3 ms, p99 6 ms; send to the rollup block that holds it
  (10 ms slots) p50 8 ms, p90 17 ms, p99 20 ms, max 21 ms. A browser adds its own
  round trip: about 77 ms to the rollup RPC from India on a kept-alive connection, so a
  click to a confirmed order is roughly 110-130 ms. Those are rollup confirmations;
  settlement to Solana L1 happens at the next commit, every 30 minutes.

## Checks

| What | Command |
| --- | --- |
| Unit tests (frontend, client) | `npm test` |
| Market API tests | `cd workers && npx vitest run` |
| Program tests (needs `target/deploy/equinox.so`) | `cargo test --manifest-path programs/equinox/Cargo.toml` |
| Market-maker tests | `cd services/market-maker && cargo test` |
| Script tests | `node --test scripts/*.test.mjs` |
| Live end-to-end (production) | `npx tsx scripts/e2e/{onboarding,deposit,far-order,close-position,preipo,basket}.mts`, `SITE=…/launch npx tsx scripts/e2e/launch.mts` |
| Deployed program matches the build | `node scripts/verify-deployment.mjs` |
| Full lifecycle (setup → delegate → trade → commit → restore → withdraw) | `scripts/v3-e2e-run.sh <state-name>`; evidence of the 2026-09-23 run: `devnet-e2e-lifecycle-20260923.json` |
