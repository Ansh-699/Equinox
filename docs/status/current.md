# Equinox status (current: 2026-09-24)

## Current state (2026-09-24)

This section is the live summary. Everything below it is the dated history
that led here; where an older section calls something "blocked" or "not
started", this section wins.

**Working on devnet (verified live today):**
- Trading: V3 TSLA-PERP market delegated to MagicBlock `devnet-as`
  (validator `MAS1Dt9…`). Popup-free trading key, faucet, rollup seat,
  deposit (inbox 60/61), market and limit orders, withdrawal to the wallet
  (outbox 62/63). `npx tsx scripts/e2e/onboarding.mts` passes against
  production (seat #25, shard 0).
- Pyth: live verified prices; OverNight session trades, only `Closed`
  (weekends/holidays) stops orders.
- Market maker + keeper: one Rust service on the Singapore VM
  `4.194.209.138` (see `services/market-maker/README.md`). Maker ~40 ms
  send→processed; ~2 ms of it network.
- Keeper (same service, key `7JuUhGG…`, named on the core by opcode 64):
  - commits: every 120 s, all 26 child shards then the core (trading pauses
    ~1.4 s). Commits are paid by the core through the validator's magic fee
    vault, so MagicBlock's 10-sponsored-commits-per-delegation cap does not
    apply. The core's rollup balance pays (100,000 lamports per account
    commit past 25): top up with `node scripts/v3-topup-core.mjs 1`.
  - funding: hourly; the program only lets the accumulator rise (longs pay
    when the book trades above the oracle), capped by elapsed seconds.
  - liquidation: scans every seat every 3 s with the program's own risk code.
  - a failed commit closes its snapshot (opcode 65) so trading never stays frozen.
- Withdrawals pass the fee vault too (11th account), so a seat shard past 10
  commits still withdraws.
- Withdrawals never wait for a live price (program + frontend): with a live
  Pyth price they use it; with none (weekend, holiday, outage) a flat seat
  withdraws freely and a seat with a position is checked at the last verified
  price moved 25% against it (`withdrawal_mark_price`,
  `V3_STALE_WITHDRAWAL_STRESS_BPS`). Tested in
  `v3_bundle::withdrawals_never_wait_for_a_live_price`.
- Deposits: the Deposit button takes the same path as Start trading. The only
  wallet prompt is the one-time trading-key signature (remembered per
  device); faucet (if short), seat (if missing), vault deposit and rollup
  credit are signed by the trading key. `npx tsx scripts/e2e/deposit.mts`
  checks one prompt across two deposits.
- Bot latency: "processed" is the first of the websocket push or an HTTP
  status poll; pushes after a quiet spell arrived ~40 ms late, so the panel
  showed 40 ms for transactions the rollup had processed in 2-15 ms.
- Worker CPU: the browser now builds the V3 market aggregate from the rollup
  (`lib/v3-aggregate.ts`), and the cron no longer refreshes Pyth (the VM
  does); no `exceededCpu` since.

**Sponsor build (2026-09-24, later): see docs/architecture.md.**
- Pre-IPO perps (PreStocks): OPENAI-, SPACEX-, ANTHROPIC-PERP, priced by the
  VM reporter from PreStocks tokens (opcodes 66/67), one-click baskets on
  /pre-ipo. Tessera removed (the PreStocks bounty excludes other pre-IPO tokens).
- Meteora DBC launchpad: USD-priced equity curves, monitor, buy/sell,
  graduation to DAMM v2 (verified on devnet), perp listing via
  `scripts/list-market.sh … meteora` (needs ~1.3 devnet SOL per market).
- E2E: preipo (OPENAI, SPACEX), basket, launch, onboarding, deposit all pass.

**Program changes today (all deployed, 287 program tests):** keeper key
(`SetV3Keeper` 64) accepted for funding, liquidation and commit-only
snapshots; `AbortV3Snapshot` (65); snapshot records only count for the
current epoch (stale epoch-28 records had blocked commits); core-paid commits
through the magic fee vault (member 7 accounts, core 6, withdrawal request 11).

**Open:**
- Undelegation/restore of the core: the devnet delegation program still
  rejects `RequestUndelegation` (discriminator 26), re-probed 2026-09-24 with
  `node scripts/magicblock-dlp-discriminator-repro.mjs`. Not needed for
  trading, custody or commits; only to take the market out of the rollup.
- Weekends and US holidays: Pyth reports `Closed` and the program refuses
  new orders (no live price to trade against), by design. Withdrawals still work.
- No L1 escape hatch yet: if the MagicBlock rollup were down for good, step 1
  of a withdrawal (in the rollup) could not run. The vault's USDC stays safe on
  Solana; a designed emergency exit is proposed, not built.
- Operator balances to watch: faucet keeper `AmHAkH…` (it pays 0.05 SOL per
  new wallet; below 0.2 SOL it sends USDC only), the core's rollup lamports.

## Devnet end-to-end lifecycle verified (2026-09-23)

Program `8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ` runs artifact
`bc8da09d…0fc0` (dump hash verified). Market core
`9Vea9MVZCzYFKNHaHMPET9fuXXjfof8mA2F75pbBDJyV` completed the full lifecycle
with two independent traders and test collateral:

setup → seats → each trader deposits their own collateral on L1 → Pyth Lazer
TSLA update verified on L1 into `OracleSnapshotV3` → all 27 execution accounts
delegated → ER maker/taker fill (snapshot visible in ER 73–284 ms after L1
confirmation) → sharded commit visible on L1 → ER close → sharded
commit+undelegate → 27/27 restored → reconcile finalizes `Restored` → both
traders withdraw via a v0 transaction through the market lookup table. The
vault reconciles exactly (1,028,659 = liability 649,120 + fees 379,539).
Evidence and every signature: `docs/status/devnet-e2e-lifecycle-20260923.json`.
Reproduce: `scripts/v3-e2e-run.sh <state-name>`.

Protocol fixes found by the live run (each with a failing test first):

- V3 deposit/withdraw bound custody to the market authority, so no other
  trader could fund a seat; custody now binds to the seat's own trader.
- Fills credited fees to the protocol balance without reducing vault
  liability, so every traded market reconciled as a deficit and halted.
- MagicBlock's undelegation callback left the V3 core `Undelegating`
  forever; reconcile now finalizes it once all 27 accounts are program-owned.
- V3 withdrawal debited the seat twice.
- Tooling: sharded core commit sent a duplicate core account; commits needed
  a compute budget; readiness required the obsolete core oracle cache.

The MagicBlock oracle account was not used: Equinox's own authenticated
L1 snapshot is the ER price source (exponent analysis:
`docs/status/magicblock-oracle-exponent-resolution-20260922.json`).

Cloudflare (2026-09-23): market API Worker `stockstream-market-api`
(https://stockstream-market-api.ansht.workers.dev) serves the market on L1 and
ER. It had been running without its secrets because `secrets.required` binds
only listed names, and its RPC transport threw "Illegal invocation" in workerd;
both fixed. The frontend is deployed with vinext as Worker `equinox`
(https://equinox.ansht.workers.dev) using `.env.production` (public values)
and `npm run deploy:vinext`; the relay service token was rotated on both
Workers. Privy login and the relay proxy are wired and fail closed without a
session.

Website pass (2026-09-23): the market API had no CORS (every browser read was
blocked) and an empty D1 market registry (TSLA-PERP 404s); the frontend
decoded the Worker's per-domain stream shape as a flat list, read the oracle
from the stale core cache instead of the L1 snapshot, showed seat 0's position
to every visitor, hard-coded seat 0 for every new trader, and needed unset env
vars for custody accounts. All fixed and deployed; stale banner/diagnostics
text replaced with live facts. Privy login fails because the Privy app has
Solana wallet login disabled (`solana_wallet_auth: false`) -- a dashboard
setting.

SlipStream-style UI + permissionless oracle (2026-09-23): program `866cd74b…`
makes `UpdateOracleSnapshotV3` permissionless (Pyth signature authenticates;
only the core's canonical snapshot PDA is writable) and lets restored markets
accept new seats and sessions. The market API adds `POST /v1/oracle/refresh`
(keeper-paid, reused under 3 s), `POST /v1/faucet` (Privy-verified, one claim
per wallet per day; the keeper holds the test mint authority), and
`GET /v1/markets/TSLA-PERP/candles` (Pyth Pro history). The frontend has a
landing page at `/` and a dark three-column terminal at `/trade` with a Pyth
candle chart; website orders are wallet-signed and routed to MagicBlock ER via
the Magic Router. Trading requires the market to be delegated; seats and
deposits require it on L1. Runner state now lives in
`~/.local/state/stockstream` (the old `/tmp` state was lost on reboot).

Open: realized PnL is not withdrawable; liquidation-fee ledger
accounting with bad debt; browser session-key trading on the delegated V3
path. Markets `B2B3tzNx…` and
`D5DpWM9f…` were intermediate test runs on earlier artifacts and are
abandoned.

## Current audited architecture status (2026-09-22)

The canonical public deployment manifest is
`config/equinox-deployment.json`. It fixes the Devnet program identity,
artifact provenance, TSLA oracle metadata, MagicBlock ER endpoints, and the
write-disabled release state. Frontend, client, Worker, lifecycle, and
diagnostics defaults now derive from that manifest; no market/core/collateral
addresses are exposed until a corrected fresh market is created.

### Classification

- **Source-complete / locally-tested:** collateral-mint activation guards,
  authenticated `OracleSnapshotV3` validation, snapshot-aware V3 risk
  consumers, ABI builders, deployment manifest wiring, and local risk/matching
  regressions.
- **Locally-tested:** Rust native/runtime suites, 227 frontend tests, 357 Worker
  tests, ABI parity, TypeScript checks, production build, lint, secret scan,
  SBF artifact validation, and the 54-test Playwright fixture suite. The fresh
  gate is recorded in `docs/status/verify-latest.json` for commit
  `01453238f9a87a6a4e2452bce59969152e52e417` (275 Rust tests; artifact
  `1c1bb230d94520ead90e31cb1eb40d8c42d0c2b6391a8355a3457c5de51e05de`).
- **Devnet-verified:** existing program identity, historical TSLA entitlement,
  and prior setup evidence only. The currently deployed ELF is older than the
  local source artifact.
- **MagicBlock-verified:** not satisfied. No authenticated L1 snapshot
  read-through into ER or ER session-account write has been proven.
- **Externally-blocked:** MagicBlock oracle bridge/read-through and session
  lifecycle compatibility; fresh-market creation requiring a valid SPL mint.
- **Incomplete:** live delegation, session authorization, orders, fills,
  accounting readback, commit, restoration, and withdrawal for the corrected
  architecture.

The existing zero-mint core
`82yWLiEcbcszxGgxouGRFMX7BaYWNAVboU7aVnDaxK34` remains an abandoned test
artifact and must not be repaired, delegated, or used for demo writes. No live
state was mutated during this audit.

The read-only MagicBlock feed probe found a live 144-byte feed-1435 account,
but its bytes encode exponent `5` while the Pyth catalog requires `-5`; the
historical initialization transaction encoded trailing exponent `8`. This is
an unresolved validator-side wire/provenance mismatch, not a value that the
client or Worker may normalize. See
`docs/status/magicblock-oracle-probe-20260922.json`.

## ER-compatible oracle snapshot milestone (2026-09-22)

Source/local only: an authenticated `OracleSnapshotV3` layout (`STKORS03`,
128 bytes) and opcode 58 `UpdateOracleSnapshotV3` were added. The instruction
reuses the canonical Ed25519 + Pyth `verify_message` checks, binds feed 1435,
channel 2 and exponent -5 to the TSLA core, preserves timestamp/confidence/
session/status, rejects replay/future/stale/invalid-confidence data, and writes
only the L1-owned snapshot. The snapshot is designed to be read-only by ER;
Pyth storage/treasury/fee accounts are not in the delegated 27-account bundle.

This is not deployed and has not been run against the delegated market. No
session authorization, order, fill, commit, restoration, undelegation or
withdrawal was submitted. ER read-through and live session authorization remain
unverified; the deployed program still has the original L1-only Pyth path.
Evidence and option assessment: `docs/status/tsla-er-oracle-adapter-20260922.md`.
The preparation-only fresh-deployment gate is
`docs/status/tsla-er-oracle-deployment-runbook-20260922.md`.
The latest redacted TSLA entitlement smoke is recorded in
`docs/status/tsla-pyth-smoke-20260922.json` (3/3 endpoints, no transaction).

## TSLA ER execution status (2026-09-22)

The isolated fresh TSLA market is deployed and its complete 27-account V3
execution bundle is delegated to MagicBlock ER. Real TSLA Pyth entitlement is
working (feed 1435, fixed_rate@50ms, channel 2, exponent -5), but the stored
oracle update is stale and cannot be refreshed through the delegated ER path.
The canonical `ConsumeOracleUpdateV3` transaction was simulated twice and not
submitted: with the L1 authority it returned `InvalidAccountForFee` because
the writable fee payer is not delegated; with the pre-created session signer
it reached Pyth but failed because that zero-lamport system account could not
pay the one-lamport verification transfer. The source architecture documents
this as an L1-only instruction because Pyth fee/treasury accounts cannot be
delegated (`docs/magicblock.md`), so funding alone does not establish a
supported delegated-oracle lifecycle.

Evidence: `docs/status/tsla-er-oracle-blocker-20260922.json`. No Pyth update,
session authorization, order, fill, commit, restoration, or withdrawal was
submitted in this probe. Live ER trading remains externally blocked pending a
MagicBlock-compatible oracle-feed path or validator-supported sponsor flow.

TSLA delegation hold: the previously successful opcode-48 simulation does
not establish risk preservation. Source inspection found validator bytes
214–245 overlap risk configuration at bytes 218–231. The selected validator
would overwrite maker/taker fees with values rejected by the risk reader.
The L1 deposit handler also rejects a delegated core, so collateral must
be prepared before delegation under the current custody path. See
`docs/status/tsla-delegation-blockers-20260921.md`. The prior delegation
approval proposal is withdrawn pending resolution. No transaction was
submitted in this review. `oracle_valid=true` records historical acceptance;
the stored TSLA update was 2005 seconds old at the new readback.

Local revision-2 layout fix (2026-09-21, not deployed): the collision is
resolved in source by moving V3 risk configuration out of bytes 214–245 and
making those bytes an explicit `delegation_validator` overlay. Risk config now
lives at 1672–1685, with accepted oracle session/confidence at 1686–1694.
`V3_RISK_CONFIG_VERSION` is 2; every V3 reader, the delegation guard, and the
client/Worker decoders reject revision 1 instead of reinterpreting it, so no
existing account is silently migrated. Execution now fails closed on stale,
future, or session-invalid oracle data (`V3_MAX_ORACLE_AGE_SECONDS = 10`), and
the lifecycle runner enforces L1 custody before ER delegation. Offset table,
migration boundary, and evidence: `docs/status/v3-layout-correction.md`. Full
local gate re-run passed (Rust, ABI + layout-fixture parity, frontend,
Worker, SBF artifact, lint, secret scan) and the live Pyth smoke again
returned redacted fresh TSLA updates. No program, account, or delegation
mutation was performed.

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

Program ID (Devnet): `Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ`.
Fresh V3 core: `7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei`.
Worker: `https://stockstream-market-api.ansht.workers.dev`.

## Current release alignment (2026-09-21)

- Fresh program: `Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ`
- Fresh V3 core: `7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei`
- Local and deployed artifact: `c878d70b13864c6a8d51170a67129867e64484bec8395ae455fa3c6132014b97`
- Artifact match: `true`
- Fresh account set: 29 (`1 exchange + 1 instrument + 27 V3 execution accounts`)
- Activation metadata: fixed; feed `922`, channel `2` (`fixed_rate@50ms`), exponent `-5`
- Fresh core activation: verified at slot `501862266`; live Pyth updates remain entitlement-blocked
- Entitled alternative verified read-only: `Equity.US.TSLA/USD`, feed `1435`,
  channel `fixed_rate@50ms`, exponent `-5`; the live smoke received redacted
  updates from all three endpoints.
- Isolated TSLA setup verified: exchange
  `AW5ByA33xvoewXNfRRSQ4Am9z5fYs3i9mpjdUdtbEREK`, instrument
  `9dJTKhEHupjB7bpyzCQm52ePKDq1o14XCP6MtLx6js77`, and core
  `AN7JHGoaiQ4cbB4pxeigVjSEwLsTdtRBCJsFmcmG5XBs` plus the complete 27-account
  execution bundle exist on Devnet under the fresh program. All 33 setup
  transactions simulated successfully before submission. The core is active
  with TSLA metadata. Evidence:
  `docs/status/tsla-setup-evidence-20260921.json`.
- TSLA signed Pyth update is Devnet-verified. The approved transaction
  `2hjfJxoDhZUpyjDX9YD4xMUUkjTntRBFtgNkjCfCKTzVC4gHXcW9Q4WVqyFAwmPCXFbmzmXHiQaTqZRYq3aW9H87`
  finalized in slot `501893854`. Its fresh real feed `1435` payload (channel
  `2`, exponent `-5`) passed the native Ed25519 check, deployed Pyth
  `VerifyMessage` CPI, and `ConsumeOracleUpdateV3` with `35,440` simulated
  compute units and no error. Readback confirmed `oracle_valid=true`, price
  `36982565`, and timestamp `1789992266`. The deployed storage account points
  to treasury `opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7`; using the stale
  documented treasury failed closed with `OracleUnavailable`. Payload bytes
  remain redacted. No delegation or trading transaction was included. Evidence:
  `docs/status/tsla-pyth-simulation-20260921.json`.
- Live trading: blocked; ER lifecycle not started
- Privy relay: blocked; Worker relay secrets incomplete
- MagicBlock restoration: not attempted

The authoritative machine-readable evidence is
`docs/status/fresh-deployment-20260921.json`. This section is metadata-only;
no protocol or live state was changed.

## Historical/legacy release alignment (superseded)

V3 source implementation and local verification are substantially complete.
The current checkout is `811353b4e155243e1e7d7c367770103d2c54d819`; the fresh
full gate is recorded in `docs/status/verify-latest.json` (256 Rust, 214
frontend, 355 Worker, and 54 fixture-browser tests). The deployed Devnet ELF
(`034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`) does not
match the current local ELF (`69b7fb51b8562d6e41f946c4e5f106294cba4de58b62620020010c5dcd4ba4d0`),
and its exact source commit is not recorded, so the latest V3 risk,
liquidation, matching, and commit-epoch work is not claimed live. The
deployed program is immutable (`authority: none`). Live Pyth entitlement,
Privy relay credentials, Cloudflare production secret deployment, and
MagicBlock core restoration remain externally blocked. This release follows
PATH A: freeze the verified source, present read-only Devnet and deterministic
local fixtures, and limit live claims to the deployed artifact.

Classification: source-complete means implemented in the current source;
locally-tested means covered by the fresh gate; Devnet-verified means directly
observed on Devnet; MagicBlock-verified is not currently satisfied;
externally-blocked covers unavailable credentials or validator services;
incomplete covers work requiring those blockers to clear. Full machine-readable
evidence is `docs/status/release-alignment-20260921.json`.

## Completion matrix

| Area | Status | Evidence |
|---|---|---|
| ABI authority/parity | Complete | `npm run check:equinox-abi` -> `ABI-OK`; the canonical instruction builders, account decoders, event/legacy-book decoders, session/registry/custody/oracle/MagicBlock modules, and shared encoding/transaction primitives are authoritative under `clients/equinox/src/abi/`. The compatibility surface in `clients/equinox/src/index.ts` is now a 122-line re-export facade; its remaining `decodeTradingSession` PublicKey-shape adapter and unsigned `previewPlaceOrder` helper are compatibility APIs, not duplicate ABI authorities (`799017f`). Targeted facade/V3 tests pass: 34/34, including exact MagicBlock V3 account-order and signer/writable-flag vectors. |
| DepositCollateral account ABI | Complete | commit `8abc245`; 254+ Rust tests; live Devnet vault balance matched exactly (800,000 = 2x400,000 deposits) |
| CreateVaultAccount account ABI | Complete | commit `54cd92b`; 8 new LiteSVM tests incl. a proven CPI-rollback case |
| CreateScratchAccount (op45) | Complete | commit `00c4fb7`; 6 LiteSVM tests; live on Devnet |
| Session-relayer authorization chain | Complete (V2 compatibility + V3 bundle/risk guard locally verified) | commits `8c4d624`, `ef27085`; the relayer now derives and validates the canonical 29-account V3 execution bundle (core, 18 pages, 4 seats, 4 events, session signer, session PDA), rejects address-table lookups, duplicate/reordered/substituted accounts, signer/writable mismatches, unsupported transaction versions, expired blockhashes, and signed-order notional/exposure/open-order limit violations before co-signing. Worker tests: 355 passing, including V3 main-wallet/session nonce-mode enforcement. Live Privy/nonce success remains externally blocked. |
| Worker deployment | Complete, live-reverified; config hardened | `https://stockstream-market-api.ansht.workers.dev`; real D1 database (`1dced396-c76a-4147-8a4f-70465e9aff55`, 7 migrations applied). Version `d71e3bdf-bd49-4a73-a19-4266c51d69bc` deploys the native `@solana/kit` V3 PDA facade and batched 27-account reads. The read-only `GET /v1/v3/markets/:core?domain=l1|er` route derives core + 18 book + 4 seat + 4 event shards; its live absent-core probe now returns the intended structured 404, not an internal error. `workers/wrangler.jsonc` now declares non-secret Pyth feed vars (`922`, `fixed_rate@50ms`) and explicitly carries D1/DO bindings plus required production secret names across staging/production; `wrangler deploy --dry-run --env production` and `--env staging` confirm the bindings, while `wrangler check startup --env production` reports a 21.2 ms local startup profile. Worker V3 aggregate snapshots now expose an executable mark computed from validated paged Patricia leaves (`6d2ea54`, `80e8557`) instead of V2 arena offsets; malformed, cyclic, or missing Patricia child handles now fail closed (`2206762`), and the finalized atomic RPC context slot is carried through to the API/open-orders adapter (`77a95e2`). Funding decisions now accept that validated V3 mark while retaining a safe index-price fallback (`9e0bddf`). The session relayer and private-session projection path now require explicit V3 core + seat-shard validation and fail closed instead of applying V2 monolithic offsets (`0e2bea6`). The aggregate reader now rejects foreign-owned shard accounts (`6a387c8`). Route input/auth/response validation is now isolated in `workers/src/route-inputs.ts` with dedicated tests (`f39d5e9`). Actual secret deployment remains auth-gated. The frontend V3 open-orders adapter consumes Patricia tree attribution, its readiness strip surfaces shard counts, position/event counts, delegation status, and commit cursor state, and portfolio/trading position reads now use the V3 aggregate when configured. |
| E2E auth-bypass parity (Worker <-> Next.js) | Complete | commit `822ec18`; double-gated, Miniflare-tested, confirmed inert on the live deployment |
| Devnet lifecycle script correctness | Complete | commit `25a1b0e` + follow-ups; matches the corrected ABI everywhere |
| MagicBlock delegate (market + 4-account hot cluster) | Complete, live | market `9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS` fully delegated: L1 owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, router `isDelegated: true`; 2 real protocol bugs found and fixed live (buffer-growth cap, commit-CPI off-by-one) |
| MagicBlock commit / undelegate / restore / withdraw | Blocked (root-caused; live probe rechecked 2026-09-21) | Read-only live ER simulation previously rejects the 222,752-byte market itself as "too large to be committed". The resumable V3 repro accepts an explicit preserved core (`MAGICBLOCK_V3_REPRO_CORE=...`) and, from the current safe state where only the core is delegated, returns `0x600e` at fresh ER context slot `598440374` without submitting; evidence is `docs/status/magicblock-v3-repro-20260921.json`. The fresh `node scripts/magicblock-dlp-discriminator-repro.mjs` probe still returns `InvalidInstructionData` for discriminator 26 (`Failed to read and parse discriminator`) while discriminator 0 reaches the handler and returns only an owner error, confirming the deployed DLP has not upgraded to the vendored undelegation API. The consolidated support request is `docs/status/magicblock-support-bundle-20260920.json`; raw evidence remains in `docs/status/magicblock-commit-simulation-20260919.json`, `scripts/magicblock-commit-repro.mjs`, and `docs/status/external-blocker-probe-20260921.json`. |
| V3 committable account lifecycle | Source-complete snapshot/write slice; setup/delegation/shard-commit live; core restore blocked by deployed DLP version mismatch | The current MagicBlock scheduler source enforces `MAX_PERMITTED_DATA_INCREASE = 10,240`; V3 therefore uses 10,184-byte pages (115 nodes/page, 9 pages/side). Fresh Devnet V3 state is live at core `47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso` with 18 book + 4 seat + 4 event shards; setup/delegation signatures are in `/tmp/opencode/v3-lifecycle-state.json` and `/tmp/opencode/v3-delegation-state.json`. Read-only Devnet verification of `solana program show` and `getTransaction` confirms the finalized upgrade at slot `501407453`, exact signature `4La3hXgViTtJ3uFrnRHZXmdwbGyDWitQXJj4Czfg2T69hqXBg1wiHQZtcfsLAyhR9DtFjU5htt9ZXN7cTk2xc9MS`, immutable authority (`none`), deployed ELF length 441,856, and deployed ELF SHA-256 `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa` (raw ProgramData payload is 451,024 bytes, SHA-256 `24ee8e881c9909fb56b89571756f01e080e4c64758a8a2af176f98adc97a4bc7`). A full 27-account intent remains rejected with `0xa0000002`; the 26 child intents and core commit finalized. Child undelegations finalized, but the core callback remains pending. A direct live DLP probe proves discriminator 0 reaches its handler while discriminator 26 (`RequestUndelegation` in the vendored API) is unknown; the deployed DLP last upgraded at slot `458511904`. Owner recovery therefore cannot proceed until the validator DLP is upgraded. Source now records a snapshot epoch, per-child sequence/digest, commit phase, and core-last completeness gate; trading/custody writes reject mixed or in-progress commit phases. Worker aggregation and the frontend V3 readiness strip consume the same 27-account facade and report unavailable/incomplete state honestly. Full evidence is `docs/status/v3-recovery-evidence-20260920.json`. V3 L1 custody opcodes 53/54 include persisted governance risk parameters, funding settlement, oracle-mark maintenance-margin withdrawal checks, and local shape/risk tests. V3 session authorization/revoke/update/close builders and handlers use the full sharded bundle. Place/cancel/cancel-all/main-wallet replace, session replace, cross-tree matching, reduce-only/post-only risk gates, self-trade policy, verified Pyth ingestion, liquidation primitives (including funding settlement before the liquidation health check), and paged V3 funding updates are source-complete and locally tested; live Pyth entitlement remains externally blocked. |
| Deployment identity clarification | Devnet-verified | The row above records the raw ProgramData payload; ELF extraction is the canonical executable identity: 441,856 bytes, SHA-256 `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`. Raw payload is 451,024 bytes, SHA-256 `24ee8e881c9909fb56b89571756f01e080e4c64758a8a2af176f98adc97a4bc7`; both are captured in `docs/status/deployment-verification-20260921.json`. |
| V3 bootstrap lifecycle runner | Source complete; setup/delegation executed on Devnet; atomic snapshot semantics source-complete and locally tested | `scripts/v3-devnet-lifecycle.mjs` uses `/tmp/opencode/v3-lifecycle-state.json` (with test-only checkpoint path overrides), refuses the preserved V2 market address, resumes existing accounts without recreation, rejects an existing program-owned account with the wrong size instead of looping/recreating, and derives plan-stage claims from the setup/delegation/sharded-commit checkpoints instead of hard-coding live completion. `scripts/v3-sharded-commit.mjs` validates checkpoint ordering/core ABI and enforces the core cursor epoch (`9b9f41d`). The program now freezes trading during a snapshot, records all 26 child sequence/digest records, rejects duplicates/mixed epochs, and allows the core commit only after complete child coverage; crash safety remains transaction-atomic per step and the runner remains resumable. Pure guards now exercise interruption/resume after every child for both commit and undelegation; the V3 runner checkpoint test is covered by `node --test scripts/v3-sharded-commit-guard.test.mjs scripts/devnet-lifecycle-runner.test.mjs` (7/7). Historical evidence records the fresh core plus 18 book/4 seat/4 event PDAs and all 27 successful delegation signatures. Live commit/restore remains blocked by the validator-side DLP error above. |
| V3 live account audit | Complete, read-only | Fresh `NO_DNA=1 node scripts/v3-live-account-audit.mjs` at L1 slot `501589893` / ER slot `598337375` found all 27 derived accounts present with exact sizes 4096/10184/8236/3244. Only the core remains delegated; the 26 child shards are restored to the Equinox owner. No transaction or checkpoint mutation is performed. Evidence: `docs/status/v3-live-account-audit-20260921.json`. |
| Session-signed trading (place/cancel/replace/cross) | Blocked live; locally tested | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; catalog ID 922 is known but the installed key lacks its equity entitlement. `cargo test -p equinox --test trading_session` passes 27 tests, including explicit rejection of pre-funded system-owned authorization PDAs; V3 bundle coverage includes session replace consuming exactly one nonce with the dedicated replace permission. Frontend V3 sessions now rehydrate by the canonical core address and preserve that core in relayer-facing status after refresh (`c585022`, `f75c0da`). These tests do not constitute a Privy-relayer or Devnet trade. |
| Pyth AAPL/USD live integration | Blocked only by entitlement; catalog/runtime configured and locally tested | `node --env-file=.env.local scripts/pyth-catalog-discovery.mjs AAPL` authenticated to the official catalog and returned stable `Equity.US.AAPL/USD` ID `922` (`fixed_rate@50ms`), stable `Equity.Index.AAPL/USD` ID `3191`, and inactive `Equity.US.AAPL/USD.EXT` ID `1671`; ignored server-only `.env.local` carries the AAPL settings and is loaded only with `--env-file`. The fresh authenticated probe of feed `922` rejects all three stream endpoints with `Not entitled`, so no payload is submitted. Worker health requires a positive numeric catalog ID rather than reporting ready for a key alone. `cargo test -p equinox --test pyth_oracle` passes 19 tests, including stale input and closed/halted/corporate-action close-only behavior. Evidence: `docs/status/external-blocker-probe-20260921.json`. |
| Privy live verification | Blocked only at interactive token/relayer submission; locally tested | `scripts/privy-relay-live.mjs` verifies a fresh Privy token's audience and linked Solana wallet before any relay call, defaults to preflight-only, and now has an explicit `--submit --replay` path that resubmits the identical signed transaction with a fresh request ID and requires nonce-based rejection on the second call. The server-only app credentials load from ignored `.env.local`, but the fresh preflight still lacks `PRIVY_ACCESS_TOKEN` and `PRIVY_EXPECTED_WALLET`; no relay request, nonce consumption, or replay attempt occurred. Cloudflare secret inspection/deployment is separately auth-gated by missing `CLOUDFLARE_API_TOKEN`. Evidence: `docs/status/external-blocker-probe-20260921.json`. |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | locally-tested | `npm run build` exit 0; `next start` serves real HTTP 200; fresh `NO_DNA=1 npm run test:browser:production` passed 6/6 on the current source lineage |
| Opt-in Devnet browser E2E | Devnet-verified (read-only) | Fresh `NO_DNA=1 npm run test:browser:devnet` passed 2/2 against the real Devnet RPC and deployed Worker. It verifies app boot, Devnet/AAPL configuration, server-secret non-disclosure and the live Worker V3 aggregate contract. Signing/relay is intentionally not claimed because Pyth/Privy remain externally blocked. |
| Repository cleanup / doc classification | Complete | `docs/status/document-classification.md` classifies every `docs/*.md` file as canonical specification, operational runbook/release gate, historical research, or navigation map; this file remains the authoritative implementation snapshot. The redacted post-reauthorization Wrangler handoff is `docs/status/cloudflare-secret-deploy-runbook-20260920.md`. |
| `clients/equinox/src/index.ts` facade reduction | Complete (compatibility facade retained) | commits `7fba664`, `309a475`, `bc917d9`, `8f981f8`, `ddf3776`, `ac88ed9`, `04dbf8f`, `9576c85`, `cc799d7`, `06965ee`, `bd9eef5`, `6612697`, `80ce102`, `7004dc5`, `7009301`, `92fc7ec`, `cd9aaa2`, and `799017f` remove duplicated opcode/state authorities, correct V3 session-replace encoding, and extract V3 order/cancel/funding/oracle/commit/recovery/custody/account-creation/initialization/delegation/session/registry/V2-custody/order/oracle/MagicBlock/exchange-config/event/legacy-book decoder logic into dedicated ABI modules; `abi/encoding.ts` and `abi/transaction.ts` own shared integer, public-key, account-meta, and transaction primitives. The remaining facade is intentionally retained for parity-tested compatibility APIs. |

## Test counts (latest `npm run verify`; scope is stated explicitly)

`npm run verify` (introduced in `43ec308`) is the repository verification gate and
produces the counts below from the current checkout; it runs Rust formatting,
workspace tests, the SBF artifact verifier, ABI parity, frontend/Worker tests and
typechecks, Playwright fixture E2E, and the secret scan. It emits a
machine-readable gate record (use
`VERIFY_SUMMARY_PATH=docs/status/verify-latest.json npm run verify` to refresh
the tracked copy); the latest continuation run finished with `VERIFY-OK` on
source commit `0742dbd` (fresh full-gate checkpoint). The funding clamp correction is committed as
`a89c313`; `d563f28` additionally enforces persisted V3 maximum open interest
before mutation and session `max_open_orders` during canonical bundle
authorization.

Worker V3 read-path checkpoint: `GET /v1/v3/markets/:core?domain=l1|er` derives all 26 child PDAs from the supplied core and returns a bigint-safe aggregate. It is read-only and cannot claim live V3 state until a V3 core is deployed.

Fresh current-HEAD regression evidence: `cargo test -p equinox --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` passes after `cancel_all_v3` was corrected to decrement the owning seat's bid/ask exposure counters along with reserved margin and open-order count. This is local Pinocchio/LiteSVM-style evidence only; no Devnet account was mutated.

- Rust (native + LiteSVM runtime): 256 passing, `cargo fmt --check` clean; fresh `NO_DNA=1 cargo test -p equinox --tests` on the current checkout passed 256/256 across 29 suites. This includes configured mark-deviation, maximum-open-interest preflight, configured leverage, malformed economic-ledger rejection, malformed existing-ledger risk-update rejection, adversarial cross-tree matching, session cancel-all nonce replay protection, session open-order limits, repeated-partial-close, funding-aware liquidation, reduce-only flip rejection, and OraclePegged validation regressions.
- Fresh runtime liquidation instruction gate: `NO_DNA=1 cargo test -p equinox --features runtime-tests --test runtime_funding_liquidation_session liquidate_` passed 3/3, covering an underwater reduction, healthy-seat rejection, and emergency-authority signer rejection. This is local runtime evidence, not a Devnet liquidation.
- Workers (Miniflare/vitest): 355 passing (34 files; relayer risk/version/lifetime guards and typed V3 write-builder vectors included).
- Frontend (vitest): 214 passing (33 files), including explicit V3 execution-mode fail-closed coverage.
- Frontend (Playwright fixture E2E): 54 passing, including V3 deposit, confirmed L1 seat creation, ER-owned seat-write blocking, session authorization, place/cancel/replace/reduce-only, commit-pending blocking and restored withdrawal; opt-in Devnet read-only E2E: 2 passing.
- Frontend (Playwright production smoke): fresh `NO_DNA=1 npm run test:browser:production` passed 6/6 on current HEAD.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.
- Fresh full gate on current HEAD (`0742dbd`): `VERIFY_SUMMARY_PATH=docs/status/verify-latest.json NO_DNA=1 bash scripts/verify.sh` finished `VERIFY-OK`; Rust 256, frontend 214, Worker 355, Playwright fixture 54/54, SBF artifact verification, ABI parity, typechecks, lint, and secret scan all passed. Current local artifact SHA-256 is `69b7fb51b8562d6e41f946c4e5f106294cba4de58b62620020010c5dcd4ba4d0`; it is not deployed. The frontend withdrawal hook now blocks every known non-reconciled status, matching the on-chain guard (`4715dc3`).
- Fresh V3 economic/custody checkpoint (`717add9`, `c6ffca5`, `5f77b42`, `5ab5e47`, `aa65c7f`, `73af90b`, `d747194`, `a8cb5e3`, `4715dc3`): `MarketCoreV3` persists nonnegative `vault_surplus` at offset 1640 and `withdrawal_buffer` at offset 1656 after the 26 child commit records; the 81-byte versioned risk-update ABI, authorized update path, V3 L1 liability accounting, restored-core vault reconciliation opcode 55, canonical 30-account client/Worker builders, reconciliation safety guards, validation of existing economic ledgers before governance updates, pinned OraclePegged reservation prices, and checked session/cancel counter arithmetic are covered by the 256-test Rust gate, 214 frontend tests, and 38 targeted ABI/facade tests. Withdrawals now also reject every non-reconciled status, including the frontend write gate. This is source/local evidence only; the preserved Devnet core was not mutated or redeployed.
- Fresh Worker V3 opcode-parity regression: V3 custody builders now use named opcode constants (`depositCollateralV3=53`, `withdrawCollateralV3=54`) instead of duplicated literals; the Worker transaction suite remains 355/355.
- Fresh Worker V3 nonce-mode regression: the typed V3 place/cancel/cancel-all/replace builders reject nonzero action nonces when no session PDA is present; `workers/src/transactions.test.ts` passes 10/10 and the full Worker suite passes 355/355.
- Fresh V3 replacement preflight: `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_session_replace_consumes_one_nonce_and_requires_replace_permission` passes 1/1 after matching/post-only/IOC checks were moved ahead of cancellation; the regression proves a rejected post-only crossing replacement leaves the old page and session nonce unchanged.
- Fresh V3 frontend-boundary regression: `resolveSessionExecutionMode` preserves explicit V2 compatibility only when no V3 core is configured and rejects a configured V3 deployment whose canonical execution bundle is missing, preventing silent V2 downgrade. `npm test` passes 213/213; this is locally tested and not live-signed.
- Fresh V3 funding-risk regression: accepted resting-order placement settles the seat's pending funding accumulator before exposure/margin checks and persists it exactly once when no fill occurs. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_owner_place_reserves_collateral_and_writes_paged_book_and_event` passes within the current 250-test gate.
- Fresh V3 liquidation atomicity regression: `liquidate_v3` preflights insurance, open-interest, and bad-debt ledger arithmetic before writing the seat. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_liquidation_updates_open_interest_and_insurance_fee` passes within the current 250-test gate.
- Fresh V3 cancel-all atomicity regression: `cancel_all_v3` preflights reserve and open-order/exposure counters before removing a leaf, uses checked counter subtraction, and rejects malformed seat state without changing the page. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_cancel_all_releases_reserve_and_side_exposure_for_every_tree` passes within the current 250-test gate.
- Fresh V3 replacement preflight regression: `replace_order_v3` validates the old leaf, releases its projected reserve/exposure on a copy, and checks replacement shape, oracle/risk limits, matching, post-only, and session semantics before cancellation. The V3 session-replace test proves rejected replacements leave the original page and session bytes unchanged.
- Fresh V3 margin-engine regression: placement and replacement now call the shared `risk::available_margin` guard and reject already-negative equity before any book/seat mutation. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_place_rejects_negative_available_margin_before_mutation` passes; the V3 bundle suite is now 21/21.
- Fresh V3 economic-ledger regression: `read_v3_risk_config` now rejects negative current open interest, protocol/insurance balances, bad debt, and vault liability, plus out-of-range reconciliation status and leverage values, before any trading path can consume malformed core state. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_risk_config_rejects_negative_economic_ledgers` passes; the current V3 bundle suite is 22/22. This is source/local evidence only; no preserved Devnet core was mutated.
- Fresh V3 leverage regression: placement and replacement now enforce the persisted `maximum_leverage` against settled equity and projected post-order notional; the previous implicit 1× collateral cap was removed. `NO_DNA=1 cargo test -p equinox --test v3_bundle v3_place_uses_configured_leverage_instead_of_a_hardcoded_one_x_cap` passes; the current V3 bundle suite is 23/23. This is source/local evidence only; no preserved Devnet core was mutated.
- Fresh V3 cross-tree adversarial regression: `v3_cross_tree_matching_covers_both_taker_sides_and_peg_states` covers fixed and OraclePegged makers for bid and ask takers, valid/invalid/skipped peg evaluation, expiry, executable-price ordering, and no mutation during planning. The focused test passes; this is local matching evidence only.
- Fresh V3 session cancel-all regression: `v3_session_cancel_all_consumes_one_nonce_and_rejects_replay` proves a session-authorized cancel-all starts at the canonical nonce, consumes exactly one nonce after cancelling orders, and rejects an identical replay without changing the page or session bytes.
- Client facade audit: `clients/equinox/src/index.ts` is now a thin compatibility surface (122 lines); instruction construction and canonical decoders live in `clients/equinox/src/abi/*`, with only the legacy PublicKey session mapping and unsigned preview retained in the facade.
- Earlier continuation gates are retained in git history; the authoritative fresh gate above is the 256-test `verify-latest.json` record for source checkpoint `a8cb5e3`.
- Fresh liquidation regression: `NO_DNA=1 cargo test -p equinox --test
  v3_bundle v3_liquidation_updates_open_interest_and_insurance_fee` and the
  full `NO_DNA=1 cargo test -p equinox --tests` pass after V3 liquidation
  settles the funding accumulator before maintenance-margin evaluation; the
  regression proves funding can make an otherwise healthy seat liquidatable
  and is applied exactly once. `NO_DNA=1 cargo build-sbf` also passes. This is
  local evidence only; the changed artifact is not deployed.
- Fresh V3 reduce-only regression: `NO_DNA=1 cargo test -p equinox --test
  v3_bundle v3_reduce_only_rejects_an_oversized_direction_flip_before_mutation`
  passes after the canonical V3 place path rejects a reduce-only quantity that
  exceeds the current position; this prevents a direction flip before any
  page, seat, event, or sequence mutation. The full Rust suite remains
  245/245 and `NO_DNA=1 cargo build-sbf` passes; this artifact is not deployed.
- Fresh V3 OraclePegged validation regression: `NO_DNA=1 cargo test -p
  equinox --test v3_bundle v3_place_rejects_an_invalid_oracle_peg_before_mutation`
  passes after the place path validates the taker leaf with `pegged_state`
  before matching or mutation; invalid peg limits now leave pages, seats,
  events, and the global sequence unchanged. The full Rust suite remains
  245/245; this local artifact is not deployed.
- Fresh V3 accounting guard: `NO_DNA=1 cargo test -p equinox --test
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
- Commit-limit correction (`6492c75`): `cargo test -p equinox --test
  magicblock` (30), `--test v3_bundle` (7), root V3 ABI tests (6), Worker
  V3 state tests (4), both TypeScript checks, ABI parity, and a loadable SBF
  build pass. Current local artifact SHA-256:
  `30db974b2e714ead376fc4eb5c206c278508d816f1407922e02a3841cc4ac469`.
- V3 custody/risk wire path: `cargo test -p equinox --test
  v3_bundle --test program_boundary` passes 12 + 9 tests; client custody
  golden vectors pass; full `bash scripts/verify.sh` passes Rust workspace,
  SBF build, ABI parity, 207 frontend tests, 350 Worker tests, Playwright
  50/50, TypeScript, lint and secret scan. V3 risk configuration is persisted
  in the core; withdrawal settles funding and enforces oracle-mark maintenance
  margin and reserved-order health. Live custody was not attempted because
  the preserved V3 core remains pending restore.
- V3 session-replace follow-up: `cargo test -p equinox --test v3_bundle
  v3_session_replace_consumes_one_nonce_and_requires_replace_permission`
  passes; commit `4776550` and upgraded artifact
  `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`.
- V3 self-trade follow-up: `v3_self_trade_policies_apply_on_paged_books`
  covers abort, decrement-take, and cancel-provide behavior across the paged
  book; the deployed artifact is `034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa`.

## Known external blockers (historical, 2026-09-21; see "Current state" above)

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
retrofit the preserved V2 market. A fresh identity-correct V3 deployment and
all 27 core/child accounts now exist. Instrument metadata is configured for
feed 922, channel 2 (`fixed_rate@50ms`), and exponent -5, and fresh-core
activation is verified at slot `501862266`. Live oracle updates and trading
remain blocked because all three Pyth streams reject feed 922 as `Not
entitled`. The ER lifecycle has not started; it still requires an entitled
Pyth update, Privy credentials, and a compatible DLP restore path.

## Live evidence artifacts

- `docs/status/fresh-deployment-20260921.json` -- identity-correct fresh
  program deployment and fresh V3 account-bundle evidence. The new ELF is
  hash-equivalent to the local artifact and the new program is upgradeable;
  instrument metadata configuration and core activation are verified. Pyth
  feed 922 entitlement remains the live-oracle and live-trading blocker. No
  live trading or MagicBlock lifecycle claim follows from this account
  bootstrap and activation.

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
- Fresh identity-correct program: `Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ`,
  upgrade signature `4dZxMMQzTS69zqgr55oVaPTb7AiwjZ6CQBuWdjZFBTsdzdNTjhJbPBGaq6sETPiSkxstAUcj1XH7yNKCxEQVYtcv`,
  slot `501840717`, artifact SHA-256
  `c878d70b13864c6a8d51170a67129867e64484bec8395ae455fa3c6132014b97`.
- Live Worker: `https://stockstream-market-api.ansht.workers.dev`
  (D1 database `1dced396-c76a-4147-8a4f-70465e9aff55`).
- `docs/status/magicblock-commit-simulation-20260919.json` -- sanitized,
  read-only ER simulation; the full regenerable output is
  `/tmp/opencode/magicblock-commit-simulation.json`.

## UI port — 2026-09-23

- `/` is the Onyx landing re-cut for perps (`features/landing/`): sky hero with glass credibility pill, liquid-glass CTA, sliding tab pill driving a floating app panel (Trade on real Pyth history + terminal sizing math; Markets/Portfolio/Activity with illustrative data tagged), scroll reveals, mega footer.
- `/trade` is the SlipStream terminal (Tailwind v4, `--t-*` tokens, dark/light toggle): TerminalNav, market bar with market picker, canvas chart, V3 order book from the Worker aggregate (ER while delegated, L1 otherwise; Book/Trades, depth bars, click-to-price), Market/Limit ticket sized as amount × multiplier, Wallet/custody panel, session keys, system status, activity drawer (positions/open orders/fills), status strip.
- While the on-chain snapshot is stale (it only refreshes on trade), headline/ticket prices use the latest Pyth close and the bar shows the snapshot age.
- Known: the V3 aggregate route intermittently hits the Worker CPU limit (error 1102); the book tolerates single failures and polls every 15 s on L1 / 3 s in the ER.

## Live market, sponsors, wallet — 2026-09-23 (later)

- Program upgraded (sha 3e901121…): a `Restored` + idle + reconciled core can be delegated again, and its commit sequence continues from `last_committed + 1` (was: one delegation per market ever). Unit-tested in `magicblock::delegation_status_tests`.
- Worker: one-minute cron refreshes the TSLA Pyth snapshot (keeper jobs stay opt-in via `KEEPER_ORCHESTRATION=on`); `POST /v1/operator/mint` (ingestion bearer) mints test collateral; `GET /v1/pre-ipo` proxies PreStocks + Tessera.
- Market maker: now `services/market-maker` (see the 2026-09-24 sections). Delegation: `scripts/v3-delegate-market.sh` (market authority, local only).
- Terminal book reads the rollup directly (websocket `accountSubscribe` on book/seat/event shards, 1 s fallback poll) — no Worker in the path.
- New tabs: Launch (Meteora DBC createConfigAndPool, three equity-tuned presets, simulated OK on devnet) and Pre-IPO (PreStocks/Tessera marks vs token price).
- Wallet: Disconnect everywhere; a connected-but-unauthenticated wallet gets "Finish sign-in" + "Disconnect"; Privy account shown in the wallet panel and System Status.
- Market delegated to MagicBlock (done by the operator).

## Popup-free trading, rollup withdrawals, live MM — 2026-09-24

- Program (sha c53cb603…): deposit inbox (60 deposit on L1, 61 claim in the rollup) and withdrawal outbox (62 request in the rollup: risk-checked debit + seat-shard commit to L1; 63 claim on L1, paid once per request to the trader's own USDC account). Runtime-tested; deployed.
- Trading key (`lib/trading-key.ts`): one wallet signature derives the in-app key (sha256 of a domain-bound signed message); it signs seat, deposits, orders, cancels and withdrawals silently, and withdrawals forward to the wallet. "Start trading" = faucet → rollup seat → 100 USDC deposit. The market-authority-only V3 session panel is hidden when live wallet trading is configured.
- Market maker: first a `MarketMaker` DO in `apac-se` (SIN, ~4 ms from devnet-as; p50 ≈ 11 ms send → processed push). Superseded the same day: see below.
- Browser: rollup transactions go straight to devnet-as (validator MAS1…) with websocket confirmation; the terminal's live-transactions panel shows the bot's and your own times (from India ≈ 80 ms, nearly all network).
- Live checks against production: `npx tsx scripts/e2e/onboarding.mts` (fresh keypair injected as a Wallet Standard wallet).

## Market maker moved to a VM service — 2026-09-24 (later)

- The `MarketMaker` Durable Object hit Durable Object request limits (a tick every ~0.5 s). It is deleted (Worker migration `v3`), and the bot keys were removed from the Worker's secrets.
- `services/market-maker`: a standalone Rust service (tokio) for a VM, ideally in Singapore next to devnet-as. It does what the DO did: incremental ReplaceOrder quoting, size jitter, taker fills, send → `signatureSubscribe` latency, and a permissionless Pyth refresh through the Worker. It also pauses while Pyth reports the US session closed; the program refuses orders then (`InvalidAccountData` from snapshot validation).
- Instruction bytes and PDAs are tested against fixtures generated from `clients/equinox`; the signed transaction is compared with web3.js's. Deploy notes (systemd, Docker, Caddy/sslip.io HTTPS) are in `services/market-maker/README.md`.
- Status: the terminal polls `NEXT_PUBLIC_MM_STATUS_URL` (the VM over HTTPS) directly; the Worker's `GET /v1/mm/status` proxies to `MM_STATUS_URL` as a fallback and returns 503 while neither is configured.
- Terminal: when Pyth reports the market closed, the order button reads "Market closed", the empty book explains US session hours, and the transactions panel says the bot is idle.

- Deployed: Azure VM `4.194.209.138` (southeastasia, ~2 ms from devnet-as; moved from eastus on 2026-09-24). The systemd unit `stockstream-mm` listens on `127.0.0.1:8787`; its only public surface is Caddy at `https://4-194-209-138.sslip.io/v1/mm/status` (automatic Let's Encrypt; needs inbound 80/443 open in the Azure NSG). The frontend sets `NEXT_PUBLIC_MM_STATUS_URL`, and the Worker's `MM_STATUS_URL` points at the same URL. Bot send→processed is ~40 ms (≈2 ms network, the rest the rollup confirming at its block boundary).
- Overnight trading (user decision, 2026-09-24): V3 treats Pyth `OverNight` (session 3, live Blue Ocean prices 8 PM–4 AM ET) as OPEN; only `Closed` (4: weekends, holidays) stops orders. Program upgraded (sha 8c67f038…); the legacy V2 mapping is unchanged. Unit test: `oracle_snapshot::overnight_trades_and_only_closed_stops_orders`.
- Oracle refresh: devnet's clock trails wall time by 1–2 s and the program rejects prices >2 s ahead of it, so the Worker now retries a rejected update (3 attempts, 1.2 s apart). A failed refresh no longer blocks an order when the rollup price is ≤8 s old; the program's 10 s check still decides.
