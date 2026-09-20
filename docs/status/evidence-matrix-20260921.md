# StockStream evidence matrix

This matrix is scoped to the current checkout (`8ec5497`). “Fresh” means rerun on this checkout; live claims additionally require the cited Devnet artifact. The full local gate is `VERIFY_SUMMARY_PATH=/tmp/stockstream-verify-summary-20260921-liquidation.json bash scripts/verify.sh` and the checked-in summary is `verify-latest.json`.

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
| V3 PnL accounting | locally-tested | `programs/stockstream/src/risk.rs`; `cargo test -p stockstream --test state_risk repeated_partial_closes_preserve_fractional_entry_value` verifies proportional entry allocation across repeated partial closes | yes |
| V3 fee accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| V3 funding accounting | locally-tested | `programs/stockstream/src/risk.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| V3 open-interest accounting | locally-tested | `programs/stockstream/src/v3.rs`; commit `d563f28`; `NO_DNA=1 cargo test -p stockstream --tests`, including `v3_place_rejects_maximum_open_interest_before_mutation` | yes; current HEAD gate |
| V3 liquidation | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/handlers.rs`; `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_liquidation_updates_open_interest_and_insurance_fee` verifies funding settlement before health evaluation, exactly-once funding application, position/open-interest reduction, insurance fee, and recognized bad debt | yes; no live liquidation |
| Fixed/OraclePegged matching | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_place_rejects_an_invalid_oracle_peg_before_mutation` plus `cargo test -p stockstream --test order_book` | yes |
| post-only | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test order_book` | yes |
| IOC | locally-tested | `programs/stockstream/src/book.rs`; `cargo test -p stockstream --test order_book --test account_settlement` | yes |
| reduce-only | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/handlers.rs`; `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_reduce_only_rejects_an_oversized_direction_flip_before_mutation` plus the full Rust suite | yes |
| maximum-open-orders | locally-tested | `programs/stockstream/src/v3.rs`, `programs/stockstream/src/session.rs`; commit `d563f28`; `NO_DNA=1 cargo test -p stockstream --tests`, including V3 session actor limit coverage | yes; current HEAD gate |
| cancel accounting | locally-tested | `programs/stockstream/src/v3.rs`; fresh `v3_bundle` suite (20 tests) now uses checked subtraction for maker fills and cancel-all reserve/open-order/exposure release, with `v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` covering both trees | yes |
| cancel-all accounting | locally-tested | `programs/stockstream/src/v3.rs`; `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` covers both trees, checked releases, and stale-oracle cancellation | yes |
| replace accounting | locally-tested | `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test v3_bundle` | yes |
| self-trade behavior | locally-tested | `programs/stockstream/src/book.rs`, `programs/stockstream/src/v3.rs`; `cargo test -p stockstream --test self_trade --test v3_bundle` | yes |
| atomic sharded commit epochs | locally-tested | `programs/stockstream/src/v3.rs`, `scripts/v3-sharded-commit.mjs`; `node --test scripts/v3-sharded-commit-guard.test.mjs scripts/devnet-lifecycle-runner.test.mjs` | yes (local guards only) |
| relayer 27-account validation | locally-tested | `workers/src/session-relayer.ts`, `clients/stockstream/src/abi/v3.ts`; Worker tests in `verify-latest.json` | yes |
| frontend V3 order writes | locally-tested | `features/sessions/use-session-order.ts`, `clients/stockstream/src/abi/`; `npm test`, Playwright fixture E2E 54/54 | yes; not live-signed |
| frontend V3 custody writes | locally-tested | `features/collateral/`, `clients/stockstream/src/abi/`; `npm test`, Playwright fixture E2E 54/54 | yes; Devnet custody preserved/not attempted |
| Worker V3 writes | locally-tested | `workers/src/transactions.ts` now exposes typed V3 order/cancel/replace wrappers plus opcode-53/54 custody builders; `workers/src/transactions.test.ts` verifies the 28-account execution shape, 11-account deposit shape, 33-account withdrawal shape, and session-PDA rejection. Live secret-backed write deployment remains unverified. | yes |
| Pyth live ingestion | externally-blocked | `scripts/pyth-catalog-discovery.mjs`, `scripts/pyth-live-smoke.mjs`; `docs/status/external-blocker-probe-20260921.json` | yes (entitlement rejection) |
| Privy live relay | externally-blocked | `scripts/privy-relay-live.mjs`; `docs/status/external-blocker-probe-20260921.json` | yes (preflight only; no token/relay) |
| Devnet custody | externally-blocked | `programs/stockstream/src/v3.rs`; withdrawal requires restored/reconciled core; MagicBlock restore is blocked | yes (guarded, no mutation) |
| MagicBlock withdrawal lifecycle | externally-blocked | `scripts/magicblock-commit-repro.mjs`, `scripts/magicblock-dlp-discriminator-repro.mjs`; support bundle and external probe | yes |

No row above claims live trading, live Privy sponsorship, live Pyth AAPL/USD entitlement, core restoration, or withdrawal completion.
