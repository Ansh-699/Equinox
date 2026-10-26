# Equinox mainnet readiness (2026-10-26)

Pre-audit intake and release gate for moving Equinox from Solana devnet to
mainnet-beta. Method: the `solana-audit` release-gate workflow. Every status
below is backed by something run or read on 2026-10-26; items I could not verify
are marked **unverified**, never PASS. This is a self-review, not an independent
audit (see "External audit" below).

```
GATE: FAIL target=equinox-mainnet blockers=10 warnings=5 skipped=0 unverified=1
```

## 0. Progress since the first gate (cheap code blockers)

Code and tests are in the working tree, not deployed to devnet and not committed.

| Gate | Change | Verification |
| --- | --- | --- |
| 4 oracle confidence | One constant, `oracle_snapshot::MAX_CONFIDENCE_DIVISOR = 100` (1%), replaces seven copies of the 20% rule (`v3.rs`, `handlers.rs` x2, `handlers_oracle.rs`, `oracle_snapshot.rs` x2, `magicblock_oracle.rs`). Live confidences today: TSLA 0.022%, reporter markets 0.5%, both under the cap | Boundary test in `oracle_snapshot.rs`; reverting the constant to 5 fails it; 289 program tests pass |
| 6 dev surfaces | Faucet and operator mint return 404 when `ENVIRONMENT=production`; `/debug/env-presence` needs the operator bearer; `POST /v1/launches` is limited to 10 per minute per IP | 3 new Worker tests; each changed line was reverted in turn and a test failed; 380 Worker tests pass |
| 8 monitoring | `scripts/health-check.mjs` (wallet SOL floors, oracle snapshot age, market-maker tick age, commit age; optional webhook). Exits 1 on any failure | 4 tests (`scripts/health-check.test.mjs`); first live run caught real stalls (below) |
| 15 program ID | `programs/equinox/build.rs` reads `EQUINOX_PROGRAM_ID` (base58, default = devnet ID). Mainnet build: `EQUINOX_PROGRAM_ID=<id> cargo build-sbf --manifest-path programs/equinox/Cargo.toml --features bpf-entrypoint` | `tests/program_id.rs` passes for default, SPL Token ID and System Program ID overrides; bad input fails the build |

Still open in these gates: the production Worker environment in
`workers/wrangler.jsonc` points at the devnet D1 database id and sets no
`CORS_ALLOWED_ORIGINS` (closed by default, which is safe, but each real origin
must be added); a mainnet program also needs the clients' and
`config/equinox-deployment.json` IDs updated; the health check still needs to be
scheduled (cron or uptime monitor) with `ALERT_WEBHOOK_URL`; and the new 1%
confidence cap only takes effect after the program is upgraded.

**Found by the first live health-check run (2026-10-26), then fixed:** OPENAI and
TSLA oracle snapshots were about 150 s old (program limit: 10 s) and the
reporters logged continuous `429 Connection rate limits exceeded`, because both
`SOLANA_RPC_URL` and `SOLANA_SEND_URL` on the VM were the public
`api.devnet.solana.com`. Fix applied on the VM: reads (`SOLANA_RPC_URL`) now go to
the Helius devnet endpoint (key taken from Caddy's existing proxy rule, never
printed), sends stay on the public RPC, as `reporter.rs` was designed. After the
restart: 0 `429`s in 30 s, 0 market-maker errors, ANTHROPIC/OPENAI posting and
committing, and the health check passes with `SKIP_MARKETS=SPACEX-PERP`. Backups:
`/etc/stockstream/mm.env.bak-rpc-*` and `mm.env.bak-pyth-*` (delete when done).
The `/etc/stockstream/rpc-proxy-url` file still points at the retired
4.194.209.138 VM and is unused.

Open: SPACEX has no PreStocks price. It alerts, its commits fail on core rent, and
the market maker keeps trying to top up its core from the keeper wallet (0.75 SOL
per top-up on devnet; observed for OPENAI at 13:56 UTC). Remove SPACEX from the
deployment or list it in `SKIP_MARKETS` and stop its top-ups. On mainnet that top-up
loop moves real SOL (H4).

## 1. Baseline evidence (what passes today)

| Suite | Result |
| --- | --- |
| Frontend + client (`npm test`) | 271 passed, 49 files |
| Market API Worker (`cd workers && npx vitest run`) | 377 passed, 41 files |
| Scripts (`node --test scripts/*.test.mjs`) | 30 passed |
| Market maker (`cd services/market-maker && cargo test`) | 24 passed |
| Program, all suites against a fresh SBF build (`cargo build-sbf ... --features bpf-entrypoint`, then `cargo test --manifest-path programs/equinox/Cargo.toml`) | 288 passed, 0 failed (artifact sha256 `c935055e5435044e...`) |
| Secret scan (`npm run check:secrets`) | OK |
| Live devnet: oracle snapshots updating every ~4 s, candles for 3 of 4 markets, keeper commits resuming | verified after the Oct 26 fix |

Tests passing proves the devnet design works. It does not clear any blocker below.

## 2. Release gate

| # | Check | Status | Evidence | Required to clear |
| --- | --- | --- | --- | --- |
| 1 | Upgrade authority custody | **FAIL (Critical)** | `solana program show 8Ucds...cxFZ -u devnet` shows authority `A5sV4Pk...YVc8`, which is the local `~/.config/solana/id.json` hot key | Mainnet program authority = multisig (Squads) with timelock, or burn it after the audit. Deploy key must not equal upgrade authority |
| 2 | Build provenance | **FAIL** | `scripts/verify-deployment.mjs` compares the devnet binary only; no reproducible-build or verified-build artifact exists for mainnet | `solana-verify` (or equivalent) reproducible build, hash recorded in `config/`, tied to the audited commit |
| 3 | Oracle trust model, reporter markets | **FAIL (High)** | OPENAI/SPACEX/ANTHROPIC prices come from one `price_reporter` key posting an unauthenticated PreStocks HTTPS value (`reporter.rs`), bounded 0.5%+0.1%/s per post. Reporter key = keeper key, stored as a file on one VM | Either exclude reporter markets from mainnet v1, or: multi-source index, hard OI caps, circuit breaker, reporter key in HSM/KMS, separate keys per role |
| 4 | Oracle guard thresholds | **FAIL (High, hardening)** | `validate_v3_oracle_freshness` (`v3.rs`) accepts confidence up to 20% of price (`confidence > price/5`) and 10 s age | Set confidence cap per market (about 0.5-1% for equities) and fuzz liquidation/margin paths at the cap |
| 5 | Client key custody | **FAIL (High)** | `lib/trading-key.ts`: trading key = SHA-256 of one wallet signature over a fixed text message, stored in `localStorage`. File comment says "devnet-grade custody". Any site that gets a user to sign the same text derives the same key; any XSS reads it. The key signs deposits, orders and withdrawals | Replace with the program's scoped trading sessions (`create_v3_trading_session`) or Privy embedded wallets; withdrawals must require the owner wallet |
| 6 | Dev surfaces in the production Worker | **FAIL** | Public `/debug/env-presence`; `/v1/faucet` and `/v1/operator/mint` mint the shared *test* USDC; `ENVIRONMENT: development`; CORS allowlist includes localhost; public `POST /v1/launches` writes D1 | Strip or hard-gate on `ENVIRONMENT=production`; no faucet/mint on mainnet; remove localhost origins; rate-limit or auth launches |
| 7 | Rollup liveness and fund access | **FAIL (unverified on mainnet)** | User funds sit in delegated ER accounts; L1 sees them only after `commit`. On devnet the keeper commit path was failing (`InsufficientFundsForRent`) from Oct 17 until Oct 26 with no alert. Withdrawal depends on commit/undelegate | Written ER-outage runbook; mainnet dress rehearsal of commit, undelegate, withdraw with small balances; confirm mainnet validator identity, commit fees and the per-delegation commit limit |
| 8 | Monitoring and alerting | **FAIL** | The Oct 21-26 stale-price outage ran about 5 days unnoticed; root cause was a wallet at 0.00065 SOL. Single VM, no firewall on the host (`ufw` inactive), no paging | Alerts on: keeper/reporter/maker SOL balance, oracle snapshot age, commit age, MM `errors`, RPC 429 rate; auto-top-up policy with a cap |
| 9 | Independent audit | **FAIL** | Repo docs state reviews were "this session's own ... pass (not an independent audit)". About 12k lines of Pinocchio program code, custom account layouts, hand-encoded program IDs | At least one external audit of `programs/equinox`, plus Worker/keeper signing paths; all Critical/High fixed and re-reviewed |
| 10 | Transaction landing and RPC | WARN | MM uses public `api.devnet.solana.com` for reads and sends; 429s on every startup; funding updates fail whenever a snapshot is more than 10 s old | Keyed or dedicated RPC with fallback; bounded confirm loop, blockhash expiry rebuild, finality target documented |
| 11 | Compute and account limits | WARN | Docs report about 90k CU per replace, 53k per taker order. No measured worst-case for liquidation, 27-account bundle commit, or `MAX_INVALID_REMOVALS` book cleanup on mainnet limits | Per-instruction CU table including worst cases, committed to `docs/` |
| 12 | Account size, rent, program size | WARN | Program data 584,312 bytes on devnet (about 2.97 SOL rent); mainnet needs program rent, a buffer, and 27 accounts per market funded | Budget in SOL, funded before deploy |
| 13 | Upgrade and migration lifecycle | WARN | Layouts are versioned (`V3_LAYOUT_VERSION`), but no mixed-version or fork-simulation evidence | Fork or LiteSVM migration test on real account bytes; keep prior binary |
| 14 | CI coverage | WARN | `equinox-runtime.yml` covers the program and the secret scan only; frontend, Worker, market-maker and script tests are not in CI; no fuzz/property tests found | Run all five suites in CI on every PR; add property tests for book, risk and settlement |
| 15 | Hardcoded program ID | **FAIL** | `programs/equinox/src/lib.rs` embeds the devnet program ID as `ID` | New mainnet program keypair, regenerate `ID`, rebuild, update clients and `config/equinox-deployment.json` |
| 16 | Legal and market access | **unverified** | Perpetuals on tokenized pre-IPO equities for public users | Owner decision with counsel; geo-blocking and terms |
| 17 | Collateral token | PASS (design) / unverified (config) | Program accepts the legacy SPL Token program only (`TOKEN_PROGRAM_ID`); Token-2022 collateral is rejected by construction | Pin mainnet USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) in the deployment config and assert it in a test |

Blockers: checks 1-9 and 15 (10 FAIL). Check 4 is a hardening change rather
than a known exploit; it still gates any market with real collateral. Checks
10-14 are warnings, check 16 is unverified, check 17 passes by design.

## 3. Findings by status

**Confirmed (read or executed today)**
- C1 Upgrade authority is a single local key (gate 1).
- C2 Client trading key custody (gate 5), per the code's own comment.
- C3 Oracle confidence cap of 20% and reporter single-key path (gates 3, 4).
- C4 Faucet, operator mint, debug route and `development` environment in the production Worker (gate 6).
- C5 No alerting; one outage ran about 5 days (gate 8).
- C6 Devnet program ID compiled into the binary (gate 15).

**Hypotheses to confirm or falsify in the audit**
- H1 `initialize_exchange` (`registry.rs`) makes the first signer on a program-owned, correctly sized account the exchange authority. Safe only if account creation and initialization are in one transaction; confirm in the mainnet deploy script, or front-running can capture the exchange.
- H2 Funding updates stop whenever the snapshot is older than 10 s. Under public-RPC 429s the reporter misses that window, so funding can skip. Measure the funding gap over 24 h on a keyed RPC.
- H3 Commit cadence (`MM_COMMIT_EVERY_S=1800`) bounds how stale L1 is relative to the rollup; confirm the effect on liquidation and withdrawal checks.
- H4 Reporter economics: the keeper key is also the reporter and tops up cores (`MM_CORE_TOPUP_SOL`). Measured devnet burn was about 0.2 SOL/h but includes core top-ups; measure the real per-market fee burn before sizing a mainnet float.

**Residual risks to accept explicitly**
- Dependence on MagicBlock ER operators and the Pyth Pro (Lazer) service and API key.
- Single-region, single-VM market maker.
- PreStocks tokens are third-party issued claims on SPV exposure.

## 4. Mainnet cutover inventory (devnet values to replace)

Files with devnet constants (grep, non-test): `config/equinox-deployment.json`,
`workers/wrangler.jsonc`, `workers/src/keeper-signer.ts`, `workers/src/faucet.ts`,
`services/market-maker/src/{main,lib,pyth_refresh}.rs`, `features/launch/*`,
`features/landing/landing-view.tsx`, `features/trading/{trading-terminal,lifecycle-panel}.tsx`,
`lib/trading-key.ts`, `scripts/*` (lifecycle, e2e harness, verify-deployment).

Replace or re-verify: Solana RPC and WebSocket; Magic Router and ER endpoint plus
validator identity; collateral mint; program ID; exchange/market/core addresses;
Pyth Pro feed IDs and API key; Privy app (production app and domain); D1 database
(fresh, not the devnet one); Worker secrets (`KEEPER_KEYPAIR_JSON`,
`RELAYER_KEYPAIR_JSON`, `INGESTION_TOKEN`, `PYTH_PRO_API_KEY`, RPC URL); `ENVIRONMENT`;
CORS origins; user-visible "devnet" strings; Meteora launchpad cluster addresses.

## 5. Audit and verification plan

Run in order; each phase has an exit criterion.

1. **Freeze and provenance.** Tag a commit; reproducible SBF build; record hash. Exit: hash reproduces on a second machine.
2. **Fix gate blockers 1, 3-6, 8, 15** (authority, oracle, key custody, dev surfaces, alerts, program ID). Exit: each has a test or runbook.
3. **Property and fuzz tests** (new). Targets: order book matching invariants, margin/liquidation at the confidence cap, settlement conservation (vault balance equals sum of seat claims plus fees plus insurance), funding sign and overflow, `u64`/`i128` boundaries, duplicate-account aliasing, Token account substitution. Tools: proptest in-crate, plus LiteSVM harness already used by `tests/runtime_*`. Exit: invariants run 1M+ cases clean.
4. **External audit** of the program, then of Worker and keeper signing. Scope doc = this file plus `docs/architecture.md`, `custody.md`, `oracle.md`. Exit: all Critical/High closed and re-reviewed.
5. **Mainnet dress rehearsal with caps.** Deploy under the multisig, one market, deposit cap per wallet and global OI cap, Pyth-priced market only. Exercise: deposit, orders, funding, liquidation, commit, undelegate, withdraw, pause, ER outage drill, key rotation, upgrade with prior binary retained. Exit: every drill logged with signatures.
6. **Staged launch.** Small caps, 24-48 h watch, alerts armed, then raise caps. Reporter (pre-IPO) markets only after gate 3 is cleared.

## 6. Decisions needed from the owner

1. Launch scope: Pyth-priced markets only (TSLA first), or also PreStocks pre-IPO markets? Recommendation: TSLA only for v1.
2. Upgrade authority: Squads multisig signers and timelock length.
3. Audit firm and budget; target dates.
4. Trading-key replacement: scoped sessions or Privy embedded wallets.
5. RPC provider and ER region for mainnet; monthly fee budget.
6. Deposit and open-interest caps for the first week.
7. Jurisdiction and access policy.
