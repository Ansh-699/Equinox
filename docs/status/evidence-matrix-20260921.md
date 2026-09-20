# StockStream evidence matrix

This matrix is scoped to the current checkout (`b93c1cf`). “Fresh” means rerun on this checkout; live claims additionally require the cited Devnet artifact. The full local gate is `VERIFY_SUMMARY_PATH=/tmp/stockstream-verify-summary-20260921.json bash scripts/verify.sh` and the checked-in summary is `verify-latest.json`.

| Subsystem | Classification | Source and exact evidence | Fresh on current HEAD |
|---|---|---|---|
| ABI and manifest parity | locally-tested | `clients/stockstream/src/abi/`, `programs/stockstream/src/instruction.rs`; `npm run check:stockstream-abi` -> `ABI-OK`; `verify-latest.json` | yes |
| V3 account layout | Devnet-verified | `programs/stockstream/src/v3.rs`; `node scripts/v3-live-account-audit.mjs`; `docs/status/v3-recovery-evidence-20260920.json` | no (historical live audit) |
| V3 PDA derivation | locally-tested | `programs/stockstream/src/v3.rs`, `clients/stockstream/src/abi/v3.ts`; `cargo test -p stockstream --tests`, ABI parity | yes |
| V3 setup lifecycle | Devnet-verified | `scripts/v3-devnet-lifecycle.mjs`; `/tmp/opencode/v3-lifecycle-state.json` | no (preserved checkpoint) |
| V3 delegation | Devnet-verified | `scripts/v3-devnet-lifecycle.mjs`; `/tmp/opencode/v3-delegation-state.json`; `docs/status/devnet-lifecycle-evidence-20260919.json` | no (preserved checkpoint) |
| V3 child commits | Devnet-verified | `scripts/v3-sharded-commit.mjs`; `docs/status/v3-sharded-commit-evidence-20260920.json` | no (preserved checkpoint) |
| V3 core commit | externally-blocked | `scripts/magicblock-commit-repro.mjs`; `docs/status/external-blocker-probe-20260921.json`; validator rejects the monolithic/core path | yes (probe evidence is current) |
| V3 undelegation | externally-blocked | `scripts/magicblock-dlp-discriminator-repro.mjs`; `docs/status/magicblock-support-bundle-20260920.json` | yes |
| V3 restoration | externally-blocked | `programs/stockstream/src/v3.rs`; `docs/status/v3-recovery-evidence-20260920.json`; DLP callback remains pending | no (live state preserved) |
| V3 risk configuration | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --tests` (risk-update vectors and bundle tests) | yes |
| V3 fill accounting | locally-tested | `programs/stockstream/src/risk.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --tests` | yes |
| V3 PnL accounting | locally-tested | `programs/stockstream/src/risk.rs`; `cargo test -p stockstream --test state_risk` | yes |
| V3 fee accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| V3 funding accounting | locally-tested | `programs/stockstream/src/risk.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| V3 open-interest accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| V3 liquidation | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/handlers.rs`; `cargo test -p stockstream --tests` | yes; no live liquidation |
| Fixed/OraclePegged matching | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test order_book --test v3_bundle` | yes |
| post-only | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test order_book` | yes |
| IOC | locally-tested | `programs/stockstream/src/book.rs`; `cargo test -p stockstream --test order_book --test account_settlement` | yes |
| reduce-only | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/handlers.rs`; `cargo test -p stockstream --tests` | yes |
| maximum-open-orders | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/session.rs`; `cargo test -p stockstream --test trading_session` | yes |
| cancel accounting | locally-tested | `programs/stockstream/src/v3.rs`; fresh regression `v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` | yes |
| cancel-all accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` | yes |
| replace accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| self-trade behavior | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test self_trade --test v3_bundle` | yes |
| atomic sharded commit epochs | locally-tested | `programs/stockstream/src/v3.rs`, `scripts/v3-sharded-commit.mjs`; `node --test scripts/v3-sharded-commit-guard.test.mjs scripts/devnet-lifecycle-runner.test.mjs` | yes (local guards only) |
| relayer 27-account validation | locally-tested | `workers/src/session-relayer.ts`, `clients/stockstream/src/abi/v3.ts`; Worker tests in `verify-latest.json` | yes |
| frontend V3 order writes | locally-tested | `features/sessions/use-session-order.ts`, `clients/stockstream/src/abi/`; `npm test`, Playwright fixture E2E 54/54 | yes; not live-signed |
| frontend V3 custody writes | locally-tested | `features/collateral/`, `clients/stockstream/src/abi/`; `npm test`, Playwright fixture E2E 54/54 | yes; Devnet custody preserved/not attempted |
| Worker V3 writes | incomplete | `workers/src/transactions.ts`, `workers/src/session-relayer.ts`; read/validation paths tested, live secret-backed write deployment not verified | yes (scope check) |
| Pyth live ingestion | externally-blocked | `scripts/pyth-catalog-discovery.mjs`, `scripts/pyth-live-smoke.mjs`; `docs/status/external-blocker-probe-20260921.json` | yes (entitlement rejection) |
| Privy live relay | externally-blocked | `scripts/privy-relay-live.mjs`; `docs/status/external-blocker-probe-20260921.json` | yes (preflight only; no token/relay) |
| Devnet custody | externally-blocked | `programs/stockstream/src/v3.rs`; withdrawal requires restored/reconciled core; MagicBlock restore is blocked | yes (guarded, no mutation) |
| MagicBlock withdrawal lifecycle | externally-blocked | `scripts/magicblock-commit-repro.mjs`, `scripts/magicblock-dlp-discriminator-repro.mjs`; support bundle and external probe | yes |

No row above claims live trading, live Privy sponsorship, live Pyth AAPL/USD entitlement, core restoration, or withdrawal completion.
