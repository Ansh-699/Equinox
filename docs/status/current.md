# Equinox status (2026-09-25)

The live state of the devnet deployment. The design is in
[`docs/architecture.md`](../architecture.md); earlier status history lives in
git (`git log -- docs/status`).

## Live on devnet

- **Program** `8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ`, deployed build
  recorded in `config/equinox-deployment.json`
  (`deployedArtifactSha256`). Rollup cost per order: replace ~90k CU, taker
  order ~53k CU.
- **Markets** (all delegated to MagicBlock `devnet-as`):
  TSLA-PERP (Pyth), OPENAI-, SPACEX- and ANTHROPIC-PERP (PreStocks via the
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

## Open

- **Undelegation**: the devnet delegation program still rejects
  `RequestUndelegation`; re-check with
  `node scripts/magicblock-dlp-discriminator-repro.mjs`. Not needed for
  trading, custody or commits.
- **Weekends and US holidays**: Pyth reports `Closed` and TSLA refuses new
  orders by design; withdrawals still work.
- **No L1 escape hatch**: if the rollup were down for good, a withdrawal's
  first step (in the rollup) could not run. The vault's USDC stays on Solana.
- **Balances to watch** (devnet SOL): faucet `AmHAkH…` (sends SOL only above
  0.2 SOL), keeper/reporter `7JuUhGG…` (~0.3 SOL/day for posts, plus the cores'
  commit fees: the service tops each core up from it automatically), the
  authority for upgrades and new markets.
