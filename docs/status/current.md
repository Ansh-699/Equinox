# StockStream status (2026-09-20, continuation)

The single authoritative snapshot of verified state. Superseded historical
reports live in `docs/` alongside their original names; this file is the
one to read first. Update it (don't create a new dated file) the next time
a comparable amount of ground is covered.

Program ID (Devnet): `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET`.
Worker: `https://stockstream-market-api.ansht.workers.dev`.

## Completion matrix

| Area | Status | Evidence |
|---|---|---|
| ABI authority/parity | Partial | `npm run check:stockstream-abi` -> `ABI-OK`; commit `7fba664` makes the public `STOCKSTREAM_INSTRUCTION` compatibility export a direct re-export of `abi/instructions::OPCODE`, removing one duplicated 51-opcode authority. V3 seat-position decoding is now shared by client ABI and Worker (`daa46f0`, `1642137`). `clients/stockstream/src/index.ts` still owns most instruction construction and is not yet a thin facade. |
| DepositCollateral account ABI | Complete | commit `8abc245`; 254+ Rust tests; live Devnet vault balance matched exactly (800,000 = 2x400,000 deposits) |
| CreateVaultAccount account ABI | Complete | commit `54cd92b`; 8 new LiteSVM tests incl. a proven CPI-rollback case |
| CreateScratchAccount (op45) | Complete | commit `00c4fb7`; 6 LiteSVM tests; live on Devnet |
| Session-relayer authorization chain | Complete | commit `8c4d624`; 31 new unit tests; deployed live, all 4 auth gates verified via curl |
| Worker deployment | Complete, live-reverified | `https://stockstream-market-api.ansht.workers.dev`; real D1 database (`1dced396-c76a-4147-8a4f-70465e9aff55`, 7 migrations applied). Version `d71e3bdf-bd49-4a73-a19a-4266c51d69bc` deploys the native `@solana/kit` V3 PDA facade and batched 27-account reads. The read-only `GET /v1/v3/markets/:core?domain=l1|er` route derives core + 18 book + 4 seat + 4 event shards; its live absent-core probe now returns the intended structured 404, not an internal error. Pyth catalog/Privy server-only bindings are deployed by name; no V3 state is claimed until a V3 core is deployed. |
| E2E auth-bypass parity (Worker <-> Next.js) | Complete | commit `822ec18`; double-gated, Miniflare-tested, confirmed inert on the live deployment |
| Devnet lifecycle script correctness | Complete | commit `25a1b0e` + follow-ups; matches the corrected ABI everywhere |
| MagicBlock delegate (market + 4-account hot cluster) | Complete, live | market `9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS` fully delegated: L1 owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, router `isDelegated: true`; 2 real protocol bugs found and fixed live (buffer-growth cap, commit-CPI off-by-one) |
| MagicBlock commit / undelegate / restore / withdraw | Blocked (root-caused) | Read-only live ER simulation rejects the 222,752-byte market itself as "too large to be committed". Account ordering, flags, owners, IDs, and CPI bytes are accepted first; the single-PDA market layout cannot fit the validator's base-layer commit path. See `docs/status/magicblock-commit-simulation-20260919.json` and `scripts/magicblock-commit-repro.mjs`. |
| V3 committable account lifecycle | Source-complete execution slice; setup/delegation/shard-commit live; core restore blocked by deployed DLP version mismatch | The current MagicBlock scheduler source enforces `MAX_PERMITTED_DATA_INCREASE = 10,240`; V3 therefore uses 10,184-byte pages (115 nodes/page, 9 pages/side). Fresh Devnet V3 state is live at core `47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso` with 18 book + 4 seat + 4 event shards; setup/delegation signatures are in `/tmp/opencode/v3-lifecycle-state.json` and `/tmp/opencode/v3-delegation-state.json`. The final recovery-capable program upgrade is byte-verified (`2RMh…211`, slot `501300663`, SHA `65597b…1509f`). A full 27-account intent remains rejected with `0xa0000002`; the 26 child intents and core commit finalized. Child undelegations finalized, but the core callback remains pending. A direct live DLP probe proves discriminator 0 reaches its handler while discriminator 26 (`RequestUndelegation` in the vendored API) is unknown; the deployed DLP last upgraded at slot `458511904`. Owner recovery therefore cannot proceed until the validator DLP is upgraded. Full evidence is `docs/status/v3-recovery-evidence-20260920.json`. Place/cancel/cancel-all and main-wallet replace remain locally tested only; session replace, V3 L1 custody/deposit/withdraw, funding/oracle ingestion and full cross-tree/self-trade policy remain incomplete. |
| V3 bootstrap lifecycle runner | Source complete; setup/delegation executed on Devnet | `scripts/v3-devnet-lifecycle.mjs` uses `/tmp/opencode/v3-lifecycle-state.json`, refuses the preserved V2 market address, and created the fresh core plus 18 book/4 seat/4 event PDAs. The separate delegation checkpoint records all 27 successful delegation signatures. Commit remains explicitly blocked by the validator-side size error above; unsupported V3 custody/trading stages are not claimed live. |
| Session-signed trading (place/cancel/replace/cross) | Blocked live; locally tested | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; catalog ID 922 is known but the installed key lacks its equity entitlement. `cargo test -p stockstream --test trading_session` passes 26 tests, including nonce consumption, replay rejection and replace rollback/time-priority behavior; those tests do not constitute a Privy-relayer or Devnet trade. |
| Pyth AAPL/USD live integration | Blocked only by entitlement; catalog/runtime configured and locally tested | `scripts/pyth-catalog-discovery.mjs` authenticated to the official catalog and resolved stable `Equity.US.AAPL/USD` to numeric Lazer ID `922`, minimum channel `fixed_rate@50ms`; ignored server-only runtime files now carry those non-secret settings. All three authenticated stream endpoints reject ID 922 with `Not entitled`, so no signed payload is submitted. Worker health now requires a positive numeric catalog ID rather than reporting ready for a key alone. `cargo test -p stockstream --test pyth_oracle` passes 19 tests, including stale input and closed/halted/corporate-action close-only behavior. |
| Privy live verification | Blocked only at interactive token/relayer submission; locally tested | `scripts/privy-relay-live.mjs` now verifies a fresh Privy token's audience and linked Solana wallet before any relay call, and defaults to preflight-only. Its explicit `--submit` path carries the exact Worker request and is deliberately nonce-consuming/opt-in. No fresh token for a preserved trader, deployed relayer key, or service token is available, so live success, nonce consumption, and replay rejection are not claimed. |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | Complete | `npm run build` exit 0; `next start` serves real HTTP 200; production smoke suite 6/6 |
| Opt-in Devnet browser E2E | Complete (read-only, live) | `npm run test:browser:devnet` runs `playwright.devnet.config.ts` against the real Devnet RPC, deployed Worker and V3 core configuration; 2/2 pass. It verifies app boot, Devnet/AAPL configuration, server-secret non-disclosure and the live Worker V3 404 contract. Signing/relay is intentionally not claimed because Pyth/Privy remain externally blocked. |
| Repository cleanup / doc classification | Partial | this file added; the ~35 other `docs/*.md` files not yet individually classified (canonical/runbook/historical/obsolete) |
| `clients/stockstream/src/index.ts` facade reduction | Started, partial | commit `7fba664` removes the duplicated public opcode table in favour of the ABI authority. Instruction encoders and account-meta construction remain in the legacy facade and need incremental, parity-tested extraction. |

## Test counts (latest rerun; scope is stated explicitly)

Worker V3 read-path checkpoint: `GET /v1/v3/markets/:core?domain=l1|er` derives all 26 child PDAs from the supplied core and returns a bigint-safe aggregate. It is read-only and cannot claim live V3 state until a V3 core is deployed.

- Rust (native + LiteSVM runtime): 290 passing, `cargo fmt --check` clean.
- Workers (Miniflare/vitest): 338 passing (33 files).
- Frontend (vitest): 179 passing.
- Frontend (Playwright fixture E2E): 50 passing; opt-in Devnet read-only E2E: 2 passing.
- Frontend (Playwright production smoke): 6 passing.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.
- V3 continuation: targeted Rust instruction/bundle tests and all 187 root
  TypeScript tests passed after `5482c9a`; `npx tsc --noEmit` and ABI parity
  passed. `cargo build-sbf --manifest-path programs/stockstream/Cargo.toml
  --features bpf-entrypoint` and `scripts/verify-sbf-artifact.py` passed.
  This is a local build, not a live deployment. Current V3-seat-lifecycle
  artifact SHA-256: `f4e86719bf75db3ee28b6623787c1ed6ee674eace8dc48d7c295afccc3531662`.
- Commit-limit correction (`6492c75`): `cargo test -p stockstream --test
  magicblock` (30), `--test v3_bundle` (7), root V3 ABI tests (6), Worker
  V3 state tests (4), both TypeScript checks, ABI parity, and a loadable SBF
  build pass. Current local artifact SHA-256:
  `30db974b2e714ead376fc4eb5c206c278508d816f1407922e02a3841cc4ac469`.

## Known external blockers (not fixable from this codebase alone)

1. **Pyth Lazer equity entitlement** -- required for
   any real oracle price, which gates every session-signed trade and the
   market's own "Open" trading path. A local server-only test key is
   server-only key can query the Pyth Pro catalog, which resolves
   `Equity.US.AAPL/USD` as stable numeric Lazer ID `922`, with
   `fixed_rate@50ms` minimum. The configured key has no equity grant:
   all three authenticated streams reject 922 as `Not entitled`, so the
   smoke command safely submits nothing. The deterministic signed fixture
   remains the only available oracle test input until that grant changes.
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
   buffered state length; V3 avoids that boundary but is not deployed or
   live-verified yet.

The V3 layout avoids the identified account-size boundary, but does not
retrofit the preserved V2 market. It must be deployed and its full trading
and five-account delegation/commit lifecycle verified separately before it
can clear this blocker.

## Live evidence artifacts

- `docs/status/devnet-lifecycle-evidence-20260919.json` -- every real
  transaction signature/slot from this session's Devnet lifecycle run.
- Devnet program: `H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET`, upgrade
  authority `A5sV4PkkVM4gm3rejACvKFgxEMmj8ouGsffSKT5qYVc8`, currently
  deployed bytes sha256 `15b23465feb416122cf9a5086c3d429c5c1a23fa100b80c863507952d5d0d86b`
  (verified byte-identical to the local build after each deploy this
  session).
- Live Worker: `https://stockstream-market-api.ansht.workers.dev`
  (D1 database `1dced396-c76a-4147-8a4f-70465e9aff55`).
- `docs/status/magicblock-commit-simulation-20260919.json` -- sanitized,
  read-only ER simulation; the full regenerable output is
  `/tmp/opencode/magicblock-commit-simulation.json`.
