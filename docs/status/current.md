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
| ABI authority/parity | Partial | `npm run check:stockstream-abi` -> `ABI-OK`; commit `7fba664` makes the public `STOCKSTREAM_INSTRUCTION` compatibility export a direct re-export of `abi/instructions::OPCODE`, removing one duplicated 51-opcode authority. `clients/stockstream/src/index.ts` still owns most instruction construction and is not yet a thin facade. |
| DepositCollateral account ABI | Complete | commit `8abc245`; 254+ Rust tests; live Devnet vault balance matched exactly (800,000 = 2x400,000 deposits) |
| CreateVaultAccount account ABI | Complete | commit `54cd92b`; 8 new LiteSVM tests incl. a proven CPI-rollback case |
| CreateScratchAccount (op45) | Complete | commit `00c4fb7`; 6 LiteSVM tests; live on Devnet |
| Session-relayer authorization chain | Complete | commit `8c4d624`; 31 new unit tests; deployed live, all 4 auth gates verified via curl |
| Worker deployment | Complete | `https://stockstream-market-api.ansht.workers.dev`; real D1 database (`1dced396-c76a-4147-8a4f-70465e9aff55`, 7 migrations applied); `/v1/health/keepers` reports `signer: ready`, `magicRouter: ready`. V3 aggregation now decodes complete persisted event records and 88-byte PATRICIA leaves into ordered bid/ask views (commits `a1f48af`, `ea90ec0`) while retaining strict 17-account and shard-relationship validation. |
| E2E auth-bypass parity (Worker <-> Next.js) | Complete | commit `822ec18`; double-gated, Miniflare-tested, confirmed inert on the live deployment |
| Devnet lifecycle script correctness | Complete | commit `25a1b0e` + follow-ups; matches the corrected ABI everywhere |
| MagicBlock delegate (market + 4-account hot cluster) | Complete, live | market `9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS` fully delegated: L1 owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, router `isDelegated: true`; 2 real protocol bugs found and fixed live (buffer-growth cap, commit-CPI off-by-one) |
| MagicBlock commit / undelegate / restore / withdraw | Blocked (root-caused) | Read-only live ER simulation rejects the 222,752-byte market itself as "too large to be committed". Account ordering, flags, owners, IDs, and CPI bytes are accepted first; the single-PDA market layout cannot fit the validator's base-layer commit path. See `docs/status/magicblock-commit-simulation-20260919.json` and `scripts/magicblock-commit-repro.mjs`. |
| V3 committable account lifecycle | Partially source-complete; creation/activation SBF-runtime tested; not deployed | commits `7c91e31`, `8ffa31c`, `f037cc2`, `7e830d2`, `1148fbe`, `83a7d29`, `51d849c`, `7eb6a95`, `c6db456`, `5482c9a`, `1434629`, `6004cd4`, `aa9eb3a`, `442303c`, `18cd753`, `96633b9`: distinct V3 core/book/seat/event PDAs all remain below 50,000 bytes; opcode 46 creates/resumes them without accepting a V2 PDA; opcode 47 binds a core once to the exchange listing authority; opcode 48 delegates a bounded core/page/shard with real Delegation Program wire encodings; opcodes 49/50 create and safely close sharded seats using the full core + four seat + four event shard tuple, with global duplicate-owner checks and durable full-record events. `PagedBookV3` now preserves 32-bit global node handles across four 256-node pages, fixed/pegged roots, free-list reuse, expiry pruning and the OraclePegged root; its bounded cross-page match planner validates FIFO best keys and rejects stale plans before mutation. Event shards store 32 complete 100-byte ABI records (3,244 bytes/account) and have validated sequence-to-shard append coverage. V3 now has a withdrawal-readiness guard requiring the complete bundle, Restored status, and equal commit cursors. LiteSVM exercised creation/activation and a book page across 10,240 -> 20,480 -> 22,592 bytes; full matching settlement, custody handlers, commit scheduling and Devnet deployment are still outstanding. |
| V3 bootstrap lifecycle runner | Source complete; dry-run tested; not executed on Devnet | commit `f549af0`, `scripts/v3-devnet-lifecycle.mjs`: uses `/tmp/opencode/v3-lifecycle-state.json`, refuses the preserved V2 market address, and only sends a fresh core plus 8 book/4 seat/4 event PDAs when `--execute` is explicit. It does not claim unsupported V3 custody/trading/commit stages. |
| Session-signed trading (place/cancel/replace/cross) | Blocked live; locally tested | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; no entitled AAPL Lazer ID is available. `cargo test -p stockstream --test trading_session` passes 26 tests, including nonce consumption, replay rejection and replace rollback/time-priority behavior; those tests do not constitute a Privy-relayer or Devnet trade. |
| Pyth AAPL/USD live integration | Blocked (credential entitlement/configuration); locally tested | an installed test key authenticates but all three endpoints reject the inherited hard-coded Lazer ID 33 as an unentitled crypto-spot feed. `scripts/pyth-live-smoke.mjs` now refuses any default and requires the catalog-verified, entitled numeric Lazer ID for `Equity.US.AAPL/USD`; on-chain `consume_oracle_update` has no admin/test bypass by design. `cargo test -p stockstream --test pyth_oracle` passes 19 tests, including stale input and closed/halted/corporate-action close-only behavior. |
| Privy live verification | Blocked (user/relayer prerequisites) | local server-only app credentials are configured, but no real Privy access token for a wallet linked to either preserved Devnet trader is available, and the deployed Worker lacks both Privy and relayer-key secrets. The wallet-linkage, session/seat/nonce checks remain unit- and live-auth-gate-tested; live success, nonce consumption, and replay rejection are not claimed. |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | Complete | `npm run build` exit 0; `next start` serves real HTTP 200; production smoke suite 6/6 |
| Opt-in Devnet browser E2E | Not built | no dedicated Playwright suite exists yet; a real trading flow through it would hit the same Pyth/Privy credential gaps as the CLI lifecycle script |
| Repository cleanup / doc classification | Partial | this file added; the ~35 other `docs/*.md` files not yet individually classified (canonical/runbook/historical/obsolete) |
| `clients/stockstream/src/index.ts` facade reduction | Started, partial | commit `7fba664` removes the duplicated public opcode table in favour of the ABI authority. Instruction encoders and account-meta construction remain in the legacy facade and need incremental, parity-tested extraction. |

## Test counts (latest rerun; scope is stated explicitly)

- Rust (native + LiteSVM runtime): 289 passing, `cargo fmt --check` clean.
- Workers (Miniflare/vitest): 332 passing.
- Frontend (vitest): 179 passing.
- Frontend (Playwright fixture E2E): 50 passing.
- Frontend (Playwright production smoke): 6 passing.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.
- V3 continuation: targeted Rust instruction/bundle tests and all 186 root
  TypeScript tests passed after `5482c9a`; `npx tsc --noEmit` and ABI parity
  passed. `cargo build-sbf --manifest-path programs/stockstream/Cargo.toml
  --features bpf-entrypoint` and `scripts/verify-sbf-artifact.py` passed.
  This is a local build, not a live deployment. Current V3-seat-lifecycle
  artifact SHA-256: `f4e86719bf75db3ee28b6623787c1ed6ee674eace8dc48d7c295afccc3531662`.

## Known external blockers (not fixable from this codebase alone)

1. **Pyth Lazer equity entitlement and numeric feed ID** -- required for
   any real oracle price, which gates every session-signed trade and the
   market's own "Open" trading path. A local server-only test key is
   installed but does not entitle the inherited feed ID 33 (the provider
   reports crypto-spot); the authorized numeric Lazer ID for
   `Equity.US.AAPL/USD` has not been supplied. The public Hermes catalog
   identifies the required feed hash and its `fixed_rate@50ms` minimum,
   but that hash is not a Lazer subscription ID.
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
