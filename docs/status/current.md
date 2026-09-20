# StockStream status (2026-09-21, continuation)

The single authoritative snapshot of verified state. Superseded historical
reports live in `docs/` alongside their original names; this file is the
one to read first. Update it (don't create a new dated file) the next time
a comparable amount of ground is covered.

Takeover baseline (2026-09-20): requested base `ee3c5f6` resolves to
`ee3c5f60c025d46d032deb33ca07dcaa1e89a634`; the current branch is its
descendant at the current branch tip (verified with `git merge-base --is-ancestor`). The tracked working
tree was clean before verification; only the pre-existing untracked
`.deepseek/` directory remains. Re-run evidence is recorded in
`docs/status/takeover-baseline-20260920.json`.

Program ID (Devnet): `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET`.
Worker: `https://stockstream-market-api.ansht.workers.dev`.

## Completion matrix

| Area | Status | Evidence |
|---|---|---|
| ABI authority/parity | Complete | `npm run check:stockstream-abi` -> `ABI-OK`; the canonical instruction builders, account decoders, event/legacy-book decoders, session/registry/custody/oracle/MagicBlock modules, and shared encoding/transaction primitives are authoritative under `clients/stockstream/src/abi/`. The compatibility surface in `clients/stockstream/src/index.ts` is now a 122-line re-export facade; its remaining `decodeTradingSession` PublicKey-shape adapter and unsigned `previewPlaceOrder` helper are compatibility APIs, not duplicate ABI authorities (`799017f`). Targeted facade/V3 tests pass: 34/34, including exact MagicBlock V3 account-order and signer/writable-flag vectors. |
| DepositCollateral account ABI | Complete | commit `8abc245`; 254+ Rust tests; live Devnet vault balance matched exactly (800,000 = 2x400,000 deposits) |
| CreateVaultAccount account ABI | Complete | commit `54cd92b`; 8 new LiteSVM tests incl. a proven CPI-rollback case |
| CreateScratchAccount (op45) | Complete | commit `00c4fb7`; 6 LiteSVM tests; live on Devnet |
| Session-relayer authorization chain | Complete (V2 compatibility + V3 bundle/risk guard locally verified) | commits `8c4d624`, `ef27085`; the relayer now derives and validates the canonical 29-account V3 execution bundle (core, 18 pages, 4 seats, 4 events, session signer, session PDA), rejects address-table lookups, duplicate/reordered/substituted accounts, signer/writable mismatches, unsupported transaction versions, expired blockhashes, and signed-order notional/exposure/open-order limit violations before co-signing. Worker tests: 355 passing, including V3 main-wallet/session nonce-mode enforcement. Live Privy/nonce success remains externally blocked. |
| Worker deployment | Complete, live-reverified; config hardened | `https://stockstream-market-api.ansht.workers.dev`; real D1 database (`1dced396-c76a-4147-8a4f-70465e9aff55`, 7 migrations applied). Version `d71e3bdf-bd49-4a73-a19-4266c51d69bc` deploys the native `@solana/kit` V3 PDA facade and batched 27-account reads. The read-only `GET /v1/v3/markets/:core?domain=l1|er` route derives core + 18 book + 4 seat + 4 event shards; its live absent-core probe now returns the intended structured 404, not an internal error. `workers/wrangler.jsonc` now declares non-secret Pyth feed vars (`922`, `fixed_rate@50ms`) and explicitly carries D1/DO bindings plus required production secret names across staging/production; `wrangler deploy --dry-run --env production` and `--env staging` confirm the bindings, while `wrangler check startup --env production` reports a 21.2 ms local startup profile. Worker V3 aggregate snapshots now expose an executable mark computed from validated paged Patricia leaves (`6d2ea54`, `80e8557`) instead of V2 arena offsets; malformed, cyclic, or missing Patricia child handles now fail closed (`2206762`), and the finalized atomic RPC context slot is carried through to the API/open-orders adapter (`77a95e2`). Funding decisions now accept that validated V3 mark while retaining a safe index-price fallback (`9e0bddf`). The session relayer and private-session projection path now require explicit V3 core + seat-shard validation and fail closed instead of applying V2 monolithic offsets (`0e2bea6`). The aggregate reader now rejects foreign-owned shard accounts (`6a387c8`). Route input/auth/response validation is now isolated in `workers/src/route-inputs.ts` with dedicated tests (`f39d5e9`). Actual secret deployment remains auth-gated. The frontend V3 open-orders adapter consumes Patricia tree attribution, its readiness strip surfaces shard counts, position/event counts, delegation status, and commit cursor state, and portfolio/trading position reads now use the V3 aggregate when configured. |
| E2E auth-bypass parity (Worker <-> Next.js) | Complete | commit `822ec18`; double-gated, Miniflare-tested, confirmed inert on the live deployment |
| Devnet lifecycle script correctness | Complete | commit `25a1b0e` + follow-ups; matches the corrected ABI everywhere |
| MagicBlock delegate (market + 4-account hot cluster) | Complete, live | market `9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS` fully delegated: L1 owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, router `isDelegated: true`; 2 real protocol bugs found and fixed live (buffer-growth cap, commit-CPI off-by-one) |
| MagicBlock commit / undelegate / restore / withdraw | Blocked (root-caused; live probe rechecked 2026-09-21) | Read-only live ER simulation previously rejects the 222,752-byte market itself as "too large to be committed". The resumable V3 repro now accepts an explicit preserved core (`MAGICBLOCK_V3_REPRO_CORE=...`) and, from the current safe state where only the core is delegated, returns `0x600e` without submitting; evidence is `docs/status/magicblock-v3-repro-20260921.json`. The fresh `node scripts/magicblock-dlp-discriminator-repro.mjs` probe still returns `InvalidInstructionData` for discriminator 26 (`Failed to read and parse discriminator`) while discriminator 0 reaches the handler and returns only an owner error, confirming the deployed DLP has not upgraded to the vendored undelegation API. The consolidated support request is `docs/status/magicblock-support-bundle-20260920.json`; raw evidence remains in `docs/status/magicblock-commit-simulation-20260919.json`, `scripts/magicblock-commit-repro.mjs`, and `docs/status/external-blocker-probe-20260921.json`. |
| V3 committable account lifecycle | Source-complete snapshot/write slice; setup/delegation/shard-commit live; core restore blocked by deployed DLP version mismatch | The current MagicBlock scheduler source enforces `MAX_PERMITTED_DATA_INCREASE = 10,240`; V3 therefore uses 10,184-byte pages (115 nodes/page, 9 pages/side). Fresh Devnet V3 state is live at core `47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso` with 18 book + 4 seat + 4 event shards; setup/delegation signatures are in `/tmp/opencode/v3-lifecycle-state.json` and `/tmp/opencode/v3-delegation-state.json`. Read-only Devnet verification of `solana program show` and `getTransaction` confirms the finalized upgrade at slot `501407453`, exact signature `4La3hXgViTtJ3uFrnRHZXmdwbGyDWitQXJj4Czfg2T69hqXBg1wiHQZtcfsLAyhR9DtFjU5htt9ZXN7cTk2xc9MS`, immutable authority (`none`), deployed ELF length 441,856, and deployed ELF SHA-256 `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa` (raw ProgramData payload is 451,024 bytes, SHA-256 `24ee8e881c9909fb56b89571756f01e080e4c64758a8a2af176f98adc97a4bc7`). A full 27-account intent remains rejected with `0xa0000002`; the 26 child intents and core commit finalized. Child undelegations finalized, but the core callback remains pending. A direct live DLP probe proves discriminator 0 reaches its handler while discriminator 26 (`RequestUndelegation` in the vendored API) is unknown; the deployed DLP last upgraded at slot `458511904`. Owner recovery therefore cannot proceed until the validator DLP is upgraded. Source now records a snapshot epoch, per-child sequence/digest, commit phase, and core-last completeness gate; trading/custody writes reject mixed or in-progress commit phases. Worker aggregation and the frontend V3 readiness strip consume the same 27-account facade and report unavailable/incomplete state honestly. Full evidence is `docs/status/v3-recovery-evidence-20260920.json`. V3 L1 custody opcodes 53/54 include persisted governance risk parameters, funding settlement, oracle-mark maintenance-margin withdrawal checks, and local shape/risk tests. V3 session authorization/revoke/update/close builders and handlers use the full sharded bundle. Place/cancel/cancel-all/main-wallet replace, session replace, cross-tree matching, reduce-only/post-only risk gates, self-trade policy, verified Pyth ingestion, liquidation primitives (including funding settlement before the liquidation health check), and paged V3 funding updates are source-complete and locally tested; live Pyth entitlement remains externally blocked. |
| Deployment identity clarification | Devnet-verified | The row above records the raw ProgramData payload; ELF extraction is the canonical executable identity: 441,856 bytes, SHA-256 `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`. Raw payload is 451,024 bytes, SHA-256 `24ee8e881c9909fb56b89571756f01e080e4c64758a8a2af176f98adc97a4bc7`; both are captured in `docs/status/deployment-verification-20260921.json`. |
| V3 bootstrap lifecycle runner | Source complete; setup/delegation executed on Devnet; atomic snapshot semantics source-complete and locally tested | `scripts/v3-devnet-lifecycle.mjs` uses `/tmp/opencode/v3-lifecycle-state.json` (with test-only checkpoint path overrides), refuses the preserved V2 market address, resumes existing accounts without recreation, rejects an existing program-owned account with the wrong size instead of looping/recreating, and derives plan-stage claims from the setup/delegation/sharded-commit checkpoints instead of hard-coding live completion. `scripts/v3-sharded-commit.mjs` validates checkpoint ordering/core ABI and enforces the core cursor epoch (`9b9f41d`). The program now freezes trading during a snapshot, records all 26 child sequence/digest records, rejects duplicates/mixed epochs, and allows the core commit only after complete child coverage; crash safety remains transaction-atomic per step and the runner remains resumable. Pure guards now exercise interruption/resume after every child for both commit and undelegation; the V3 runner checkpoint test is covered by `node --test scripts/v3-sharded-commit-guard.test.mjs scripts/devnet-lifecycle-runner.test.mjs` (7/7). Historical evidence records the fresh core plus 18 book/4 seat/4 event PDAs and all 27 successful delegation signatures. Live commit/restore remains blocked by the validator-side DLP error above. |
| V3 live account audit | Complete, read-only | Fresh `NO_DNA=1 node scripts/v3-live-account-audit.mjs` at L1 slot `501589893` / ER slot `598337375` found all 27 derived accounts present with exact sizes 4096/10184/8236/3244. Only the core remains delegated; the 26 child shards are restored to the StockStream owner. No transaction or checkpoint mutation is performed. Evidence: `docs/status/v3-live-account-audit-20260921.json`. |
| Session-signed trading (place/cancel/replace/cross) | Blocked live; locally tested | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; catalog ID 922 is known but the installed key lacks its equity entitlement. `cargo test -p stockstream --test trading_session` passes 27 tests, including explicit rejection of pre-funded system-owned authorization PDAs; V3 bundle coverage includes session replace consuming exactly one nonce with the dedicated replace permission. Frontend V3 sessions now rehydrate by the canonical core address and preserve that core in relayer-facing status after refresh (`c585022`, `f75c0da`). These tests do not constitute a Privy-relayer or Devnet trade. |
| Pyth AAPL/USD live integration | Blocked only by entitlement; catalog/runtime configured and locally tested | `node --env-file=.env.local scripts/pyth-catalog-discovery.mjs AAPL` authenticated to the official catalog and returned stable `Equity.US.AAPL/USD` ID `922` (`fixed_rate@50ms`), stable `Equity.Index.AAPL/USD` ID `3191`, and inactive `Equity.US.AAPL/USD.EXT` ID `1671`; ignored server-only runtime files carry the AAPL settings. The fresh 2026-09-21 probe of feed `922` still rejects all three authenticated stream endpoints with `Not entitled`, so no payload is submitted. Worker health requires a positive numeric catalog ID rather than reporting ready for a key alone. `cargo test -p stockstream --test pyth_oracle` passes 19 tests, including stale input and closed/halted/corporate-action close-only behavior. Evidence: `docs/status/external-blocker-probe-20260921.json`. |
| Privy live verification | Blocked only at interactive token/relayer submission; locally tested | `scripts/privy-relay-live.mjs` verifies a fresh Privy token's audience and linked Solana wallet before any relay call, defaults to preflight-only, and now has an explicit `--submit --replay` path that resubmits the identical signed transaction with a fresh request ID and requires nonce-based rejection on the second call. The fresh 2026-09-21 preflight still lacks `PRIVY_ACCESS_TOKEN` and `PRIVY_EXPECTED_WALLET`; no relay request, nonce consumption, or replay attempt occurred. Evidence: `docs/status/external-blocker-probe-20260921.json`. |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | Complete | `npm run build` exit 0; `next start` serves real HTTP 200; production smoke suite 6/6 |
| Opt-in Devnet browser E2E | Complete (read-only, live) | Fresh `NO_DNA=1 npm run test:browser:devnet` passed 2/2 on current HEAD against the real Devnet RPC and deployed Worker. It verifies app boot, Devnet/AAPL configuration, server-secret non-disclosure and the live Worker V3 aggregate contract. Signing/relay is intentionally not claimed because Pyth/Privy remain externally blocked. |
| Repository cleanup / doc classification | Complete | `docs/status/document-classification.md` classifies every `docs/*.md` file as canonical specification, operational runbook/release gate, historical research, or navigation map; this file remains the authoritative implementation snapshot. The redacted post-reauthorization Wrangler handoff is `docs/status/cloudflare-secret-deploy-runbook-20260920.md`. |
| `clients/stockstream/src/index.ts` facade reduction | Complete (compatibility facade retained) | commits `7fba664`, `309a475`, `bc917d9`, `8f981f8`, `ddf3776`, `ac88ed9`, `04dbf8f`, `9576c85`, `cc799d7`, `06965ee`, `bd9eef5`, `6612697`, `80ce102`, `7004dc5`, `7009301`, `92fc7ec`, `cd9aaa2`, and `799017f` remove duplicated opcode/state authorities, correct V3 session-replace encoding, and extract V3 order/cancel/funding/oracle/commit/recovery/custody/account-creation/initialization/delegation/session/registry/V2-custody/order/oracle/MagicBlock/exchange-config/event/legacy-book decoder logic into dedicated ABI modules; `abi/encoding.ts` and `abi/transaction.ts` own shared integer, public-key, account-meta, and transaction primitives. The remaining facade is intentionally retained for parity-tested compatibility APIs. |

## Test counts (latest `npm run verify`; scope is stated explicitly)

`npm run verify` (introduced in `43ec308`) is the repository verification gate and
produces the counts below from the current checkout; it runs Rust formatting,
workspace tests, the SBF artifact verifier, ABI parity, frontend/Worker tests and
typechecks, Playwright fixture E2E, and the secret scan. It emits a
machine-readable gate record (use
`VERIFY_SUMMARY_PATH=docs/status/verify-latest.json npm run verify` to refresh
the tracked copy); the latest continuation run finished with `VERIFY-OK` on
source commit `069d406` (documentation checkpoint pending this update). The funding clamp correction is committed as
`a89c313`; `d563f28` additionally enforces persisted V3 maximum open interest
before mutation and session `max_open_orders` during canonical bundle
authorization.

Worker V3 read-path checkpoint: `GET /v1/v3/markets/:core?domain=l1|er` derives all 26 child PDAs from the supplied core and returns a bigint-safe aggregate. It is read-only and cannot claim live V3 state until a V3 core is deployed.

Fresh current-HEAD regression evidence: `cargo test -p stockstream --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` passes after `cancel_all_v3` was corrected to decrement the owning seat's bid/ask exposure counters along with reserved margin and open-order count. This is local Pinocchio/LiteSVM-style evidence only; no Devnet account was mutated.

- Rust (native + LiteSVM runtime): 250 passing, `cargo fmt --check` clean; fresh `NO_DNA=1 cargo test -p stockstream --tests` on the current checkout passed 250/250 across 29 suites. This includes configured mark-deviation, maximum-open-interest preflight, configured leverage, malformed economic-ledger rejection, adversarial cross-tree matching, session cancel-all nonce replay protection, session open-order limits, repeated-partial-close, funding-aware liquidation, reduce-only flip rejection, and OraclePegged validation regressions.
- Workers (Miniflare/vitest): 355 passing (34 files; relayer risk/version/lifetime guards and typed V3 write-builder vectors included).
- Frontend (vitest): 213 passing (33 files), including explicit V3 execution-mode fail-closed coverage.
- Frontend (Playwright fixture E2E): 54 passing, including V3 deposit, confirmed L1 seat creation, ER-owned seat-write blocking, session authorization, place/cancel/replace/reduce-only, commit-pending blocking and restored withdrawal; opt-in Devnet read-only E2E: 2 passing.
- Frontend (Playwright production smoke): fresh `NO_DNA=1 npm run test:browser:production` passed 6/6 on current HEAD.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.
- Fresh full gate on current HEAD: `VERIFY_SUMMARY_PATH=/tmp/stockstream-verify-summary-20260921-worker-opcodes.json NO_DNA=1 bash scripts/verify.sh` finished `VERIFY-OK`; Rust 250, frontend 213, Worker 355, Playwright fixture 54/54, SBF artifact verification, ABI parity, typechecks, lint, and secret scan all passed. Current local artifact SHA-256 is `f0d87f3d24fca7b24ef55a1e0715c9bc48fdec977cfd72ff4d91c8d7e5a2231c`; it is not deployed.
- Fresh Worker V3 opcode-parity regression: V3 custody builders now use named opcode constants (`depositCollateralV3=53`, `withdrawCollateralV3=54`) instead of duplicated literals; the Worker transaction suite remains 355/355.
- Fresh Worker V3 nonce-mode regression: the typed V3 place/cancel/cancel-all/replace builders reject nonzero action nonces when no session PDA is present; `workers/src/transactions.test.ts` passes 10/10 and the full Worker suite passes 355/355.
- Fresh V3 replacement preflight: `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_session_replace_consumes_one_nonce_and_requires_replace_permission` passes 1/1 after matching/post-only/IOC checks were moved ahead of cancellation; the regression proves a rejected post-only crossing replacement leaves the old page and session nonce unchanged.
- Fresh V3 frontend-boundary regression: `resolveSessionExecutionMode` preserves explicit V2 compatibility only when no V3 core is configured and rejects a configured V3 deployment whose canonical execution bundle is missing, preventing silent V2 downgrade. `npm test` passes 213/213; this is locally tested and not live-signed.
- Fresh V3 funding-risk regression: accepted resting-order placement settles the seat's pending funding accumulator before exposure/margin checks and persists it exactly once when no fill occurs. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_owner_place_reserves_collateral_and_writes_paged_book_and_event` passes within the current 250-test gate.
- Fresh V3 liquidation atomicity regression: `liquidate_v3` preflights insurance, open-interest, and bad-debt ledger arithmetic before writing the seat. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_liquidation_updates_open_interest_and_insurance_fee` passes within the current 250-test gate.
- Fresh V3 cancel-all atomicity regression: `cancel_all_v3` preflights reserve and open-order/exposure counters before removing a leaf, uses checked counter subtraction, and rejects malformed seat state without changing the page. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` passes within the current 250-test gate.
- Fresh V3 replacement preflight regression: `replace_order_v3` validates the old leaf, releases its projected reserve/exposure on a copy, and checks replacement shape, oracle/risk limits, matching, post-only, and session semantics before cancellation. The V3 session-replace test proves rejected replacements leave the original page and session bytes unchanged.
- Fresh V3 margin-engine regression: placement and replacement now call the shared `risk::available_margin` guard and reject already-negative equity before any book/seat mutation. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_place_rejects_negative_available_margin_before_mutation` passes; the V3 bundle suite is now 21/21.
- Fresh V3 economic-ledger regression: `read_v3_risk_config` now rejects negative current open interest, protocol/insurance balances, bad debt, and vault liability, plus out-of-range reconciliation status and leverage values, before any trading path can consume malformed core state. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_risk_config_rejects_negative_economic_ledgers` passes; the current V3 bundle suite is 22/22. This is source/local evidence only; no preserved Devnet core was mutated.
- Fresh V3 leverage regression: placement and replacement now enforce the persisted `maximum_leverage` against settled equity and projected post-order notional; the previous implicit 1× collateral cap was removed. `NO_DNA=1 cargo test -p stockstream --test v3_bundle v3_place_uses_configured_leverage_instead_of_a_hardcoded_one_x_cap` passes; the current V3 bundle suite is 23/23. This is source/local evidence only; no preserved Devnet core was mutated.
- Fresh V3 cross-tree adversarial regression: `v3_cross_tree_matching_covers_both_taker_sides_and_peg_states` covers fixed and OraclePegged makers for bid and ask takers, valid/invalid/skipped peg evaluation, expiry, executable-price ordering, and no mutation during planning. The focused test passes; this is local matching evidence only.
- Fresh V3 session cancel-all regression: `v3_session_cancel_all_consumes_one_nonce_and_rejects_replay` proves a session-authorized cancel-all starts at the canonical nonce, consumes exactly one nonce after cancelling orders, and rejects an identical replay without changing the page or session bytes.
- Client facade audit: `clients/stockstream/src/index.ts` is now a thin compatibility surface (122 lines); instruction construction and canonical decoders live in `clients/stockstream/src/abi/*`, with only the legacy PublicKey session mapping and unsigned preview retained in the facade.
- Earlier continuation gates are retained in git history; the authoritative fresh gate above is the 250-test `verify-latest.json` record for source checkpoint `265269e`.
- Fresh liquidation regression: `NO_DNA=1 cargo test -p stockstream --test
  v3_bundle v3_liquidation_updates_open_interest_and_insurance_fee` and the
  full `NO_DNA=1 cargo test -p stockstream --tests` pass after V3 liquidation
  settles the funding accumulator before maintenance-margin evaluation; the
  regression proves funding can make an otherwise healthy seat liquidatable
  and is applied exactly once. `NO_DNA=1 cargo build-sbf` also passes. This is
  local evidence only; the changed artifact is not deployed.
- Fresh V3 reduce-only regression: `NO_DNA=1 cargo test -p stockstream --test
  v3_bundle v3_reduce_only_rejects_an_oversized_direction_flip_before_mutation`
  passes after the canonical V3 place path rejects a reduce-only quantity that
  exceeds the current position; this prevents a direction flip before any
  page, seat, event, or sequence mutation. The full Rust suite remains
  245/245 and `NO_DNA=1 cargo build-sbf` passes; this artifact is not deployed.
- Fresh V3 OraclePegged validation regression: `NO_DNA=1 cargo test -p
  stockstream --test v3_bundle v3_place_rejects_an_invalid_oracle_peg_before_mutation`
  passes after the place path validates the taker leaf with `pegged_state`
  before matching or mutation; invalid peg limits now leave pages, seats,
  events, and the global sequence unchanged. The full Rust suite remains
  245/245; this local artifact is not deployed.
- Fresh V3 accounting guard: `NO_DNA=1 cargo test -p stockstream --test
  v3_bundle` passes with checked subtraction for maker-fill and cancel-all
  reserve, open-order, and side-exposure release. Underflow now rejects rather
  than silently saturating corrupted ledger state; the changed artifact is
  local-only.
- Fresh stale-oracle cancellation regression: the same V3 bundle test disables
  the oracle-valid flag after placing a pegged order and confirms cancel-all
  still releases its reservation using the last stored price. The validity
  flag gates new pegged orders, not cancellation of existing orders.
- Fresh V3 cancellation atomicity regression: `cancel_order_v3_with_action`
  now preflights reserve arithmetic and seat counters before removing the
  paged-book leaf. A malformed `open_order_count` rejects with page bytes
  unchanged in `v3_owner_place_reserves_collateral_and_writes_paged_book_and_event`.
- Commit-limit correction (`6492c75`): `cargo test -p stockstream --test
  magicblock` (30), `--test v3_bundle` (7), root V3 ABI tests (6), Worker
  V3 state tests (4), both TypeScript checks, ABI parity, and a loadable SBF
  build pass. Current local artifact SHA-256:
  `30db974b2e714ead376fc4eb5c206c278508d816f1407922e02a3841cc4ac469`.
- V3 custody/risk wire path: `cargo test -p stockstream --test
  v3_bundle --test program_boundary` passes 12 + 9 tests; client custody
  golden vectors pass; full `bash scripts/verify.sh` passes Rust workspace,
  SBF build, ABI parity, 207 frontend tests, 350 Worker tests, Playwright
  50/50, TypeScript, lint and secret scan. V3 risk configuration is persisted
  in the core; withdrawal settles funding and enforces oracle-mark maintenance
  margin and reserved-order health. Live custody was not attempted because
  the preserved V3 core remains pending restore.
- V3 session-replace follow-up: `cargo test -p stockstream --test v3_bundle
  v3_session_replace_consumes_one_nonce_and_requires_replace_permission`
  passes; commit `4776550` and upgraded artifact
  `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`.
- V3 self-trade follow-up: `v3_self_trade_policies_apply_on_paged_books`
  covers abort, decrement-take, and cancel-provide behavior across the paged
  book; the deployed artifact is `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`.

## Known external blockers (not fixable from this codebase alone)

1. **Pyth Lazer equity entitlement** -- required for
  any real oracle price, which gates every session-signed trade and the
  market's own "Open" trading path. A local server-only key can query the
  Pyth Pro catalog, which resolves
   `Equity.US.AAPL/USD` as stable numeric Lazer ID `922`, with
   `fixed_rate@50ms` minimum. The configured key has no equity grant:
   all three authenticated streams reject 922 as `Not entitled`, so the
   smoke command safely submits nothing. The deterministic signed fixture
  remains the only available oracle test input until that grant changes.
  Probe output is preserved in `docs/status/pyth-privy-live-probe-20260920.json`.
2. **Privy-linked test wallet and deployed relayer configuration** -- local
   server-only app credentials are configured, but a real Privy access token
   for a linked wallet matching a preserved trader is not present. The
   deployed Worker has neither Privy secrets nor a relayer key, so it
   correctly remains unable to sponsor a live request; the real round trip
   is untested.
3. **MagicBlock V2 commit rejection is structural** -- the sanitized
   read-only ER simulation in
   `docs/status/magicblock-commit-simulation-20260919.json` reaches
   `ScheduleCommit` and reports that the 222,752-byte market is too large
   to be committed. The V2 monolith cannot fit the committor's `u16`
   buffered state length. V3 avoids that boundary and is deployed with live
   setup, delegation and bounded shard-commit evidence; core restoration is
   blocked by the deployed DLP version mismatch recorded above.

The V3 layout avoids the identified account-size boundary and does not
retrofit the preserved V2 market. Its full trading and five-account
delegation/commit lifecycle still requires Pyth/Privy credentials and a
compatible DLP restore path before this blocker can be cleared.

## Live evidence artifacts

- `docs/status/devnet-lifecycle-evidence-20260919.json` -- every real
  transaction signature/slot from this session's Devnet lifecycle run.
- `docs/status/deployment-verification-20260921.json` -- fresh read-only
  Devnet transaction, program-data, authority, length, and SHA-256 evidence.
- Devnet program: `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET`, currently
  immutable (`solana program show` reports authority `none`), deployed ELF
  length 441,856 and SHA-256
  `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`
  (raw ProgramData payload: 451,024 bytes, SHA-256
  `24ee8e881c9909fb56b89571756f01e080e4c64758a8a2af176f98adc97a4bc7`)
  (finalized upgrade signature
  `4La3hXgViTtJ3uFrnRHZXmdwbGyDWitQXJj4Czfg2T69hqXBg1wiHQZtcfsLAyhR9DtFjU5htt9ZXN7cTk2xc9MS`, slot `501407453`).
- Live Worker: `https://stockstream-market-api.ansht.workers.dev`
  (D1 database `1dced396-c76a-4147-8a4f-70465e9aff55`).
- `docs/status/magicblock-commit-simulation-20260919.json` -- sanitized,
  read-only ER simulation; the full regenerable output is
  `/tmp/opencode/magicblock-commit-simulation.json`.
