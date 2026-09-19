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
| ABI authority/parity | Partial | `npm run check:stockstream-abi` -> `ABI-OK`; `clients/stockstream/src/index.ts` is still a large independent implementation, not yet reduced to a facade over `abi/` |
| DepositCollateral account ABI | Complete | commit `8abc245`; 254+ Rust tests; live Devnet vault balance matched exactly (800,000 = 2x400,000 deposits) |
| CreateVaultAccount account ABI | Complete | commit `54cd92b`; 8 new LiteSVM tests incl. a proven CPI-rollback case |
| CreateScratchAccount (op45) | Complete | commit `00c4fb7`; 6 LiteSVM tests; live on Devnet |
| Session-relayer authorization chain | Complete | commit `8c4d624`; 31 new unit tests; deployed live, all 4 auth gates verified via curl |
| Worker deployment | Complete | `https://stockstream-market-api.ansht.workers.dev`; real D1 database (`1dced396-c76a-4147-8a4f-70465e9aff55`, 7 migrations applied); `/v1/health/keepers` reports `signer: ready`, `magicRouter: ready` |
| E2E auth-bypass parity (Worker <-> Next.js) | Complete | commit `822ec18`; double-gated, Miniflare-tested, confirmed inert on the live deployment |
| Devnet lifecycle script correctness | Complete | commit `25a1b0e` + follow-ups; matches the corrected ABI everywhere |
| MagicBlock delegate (market + 4-account hot cluster) | Complete, live | market `9d75hK8GyfqajxcijLa35bEh8SYUtobqi6eSdtF42RuS` fully delegated: L1 owner `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, router `isDelegated: true`; 2 real protocol bugs found and fixed live (buffer-growth cap, commit-CPI off-by-one) |
| MagicBlock commit / undelegate / restore / withdraw | Blocked (root-caused) | Read-only live ER simulation rejects the 222,752-byte market itself as "too large to be committed". Account ordering, flags, owners, IDs, and CPI bytes are accepted first; the single-PDA market layout cannot fit the validator's base-layer commit path. See `docs/status/magicblock-commit-simulation-20260919.json` and `scripts/magicblock-commit-repro.mjs`. |
| V3 committable account lifecycle | Source complete; locally SBF-runtime tested; not deployed | commits `7c91e31`, `8ffa31c`, `f037cc2`, `7e830d2`: distinct V3 core/book/seat/event PDAs all remain below 50,000 bytes; opcode 46 creates/resumes them without accepting a V2 PDA. LiteSVM exercised core creation and a book page across 10,240 -> 20,480 -> 22,592 bytes. V3 trading, delegation bundle/commit, and Devnet deployment are still outstanding. |
| Session-signed trading (place/cancel/replace/cross) | Blocked | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; no Lazer API key in this environment (confirmed: anonymous WSS connection to the documented endpoint returns HTTP 403 at handshake) |
| Pyth AAPL/USD live integration | Blocked (credential entitlement/configuration) | an installed test key authenticates but all three endpoints reject the inherited hard-coded Lazer ID 33 as an unentitled crypto-spot feed. `scripts/pyth-live-smoke.mjs` now refuses any default and requires the catalog-verified, entitled numeric Lazer ID for `Equity.US.AAPL/USD`; on-chain `consume_oracle_update` has no admin/test bypass by design. |
| Privy live verification | Blocked (user/relayer prerequisites) | local server-only app credentials are configured, but no real Privy access token for a wallet linked to either preserved Devnet trader is available, and the deployed Worker lacks both Privy and relayer-key secrets. The wallet-linkage, session/seat/nonce checks remain unit- and live-auth-gate-tested; live success, nonce consumption, and replay rejection are not claimed. |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | Complete | `npm run build` exit 0; `next start` serves real HTTP 200; production smoke suite 6/6 |
| Opt-in Devnet browser E2E | Not built | no dedicated Playwright suite exists yet; a real trading flow through it would hit the same Pyth/Privy credential gaps as the CLI lifecycle script |
| Repository cleanup / doc classification | Partial | this file added; the ~35 other `docs/*.md` files not yet individually classified (canonical/runbook/historical/obsolete) |
| `clients/stockstream/src/index.ts` facade reduction | Not started | deliberately deferred -- the original audit itself specifies this only after every import/parity test has migrated; not safe to rush |

## Test counts (latest rerun; scope is stated explicitly)

- Rust (native + LiteSVM runtime): 289 passing, `cargo fmt --check` clean.
- Workers (Miniflare/vitest): 332 passing.
- Frontend (vitest): 179 passing.
- Frontend (Playwright fixture E2E): 50 passing.
- Frontend (Playwright production smoke): 6 passing.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.
- V3 continuation: 222 native Rust tests, 182 TypeScript tests, and one
  feature-gated LiteSVM SBF lifecycle test passed. The SBF artifact passed
  `scripts/verify-sbf-artifact.py`; this is not a live deployment claim.

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
3. **MagicBlock `commit_market` live rejection** -- after two real,
   confirmed, and fixed protocol bugs (the delegation buffer-growth cap
   and the commit-CPI account off-by-one), a further rejection
   ("invalid account data for instruction") persists even for a bare
   market-only commit with zero trailing members. Traced into the vendored
   `magicblock-validator` source (`programs/magicblock/src/
   magic_scheduled_base_intent.rs`'s `validate_commit_type_accounts`) far
   enough to rule out the "not delegated" and "confined" explanations, but
   full root-causing needs direct access to that validator's own runtime
   logs, which this environment doesn't have.

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
