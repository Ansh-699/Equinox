# StockStream status (2026-09-19, end of session)

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
| MagicBlock commit / undelegate / restore / withdraw | Blocked | `commit_market` reaches a MagicBlock-validator-side rejection ("invalid account data for instruction", reproducible even market-only) not yet root-caused from this side; downstream stages unexecuted live |
| Session-signed trading (place/cancel/replace/cross) | Blocked | requires `header.oracle_valid`, which only a real Pyth Lazer-verified price can set; no Lazer API key in this environment (confirmed: anonymous WSS connection to the documented endpoint returns HTTP 403 at handshake) |
| Pyth AAPL/USD live integration | Blocked | same credential gap as above; on-chain `consume_oracle_update` has no admin/test bypass by design |
| Privy live verification | Blocked | no real Privy app credentials in this environment; the Worker's own chain (wallet-linkage, session/seat/nonce checks) is unit- and live-auth-gate-tested, just not against real Privy |
| Frontend fixture E2E (Playwright) | Complete | 50/50 pass; 2 real bugs found and fixed (stale mock-relayer auth contract, a WS-connection race in oracle-safety.spec.ts) |
| Frontend production build | Complete | `npm run build` exit 0; `next start` serves real HTTP 200; production smoke suite 6/6 |
| Opt-in Devnet browser E2E | Not built | no dedicated Playwright suite exists yet; a real trading flow through it would hit the same Pyth/Privy credential gaps as the CLI lifecycle script |
| Repository cleanup / doc classification | Partial | this file added; the ~35 other `docs/*.md` files not yet individually classified (canonical/runbook/historical/obsolete) |
| `clients/stockstream/src/index.ts` facade reduction | Not started | deliberately deferred -- the original audit itself specifies this only after every import/parity test has migrated; not safe to rush |

## Test counts (this session, all real, all rerun after the final commit)

- Rust (native + LiteSVM runtime): 289 passing, `cargo fmt --check` clean.
- Workers (Miniflare/vitest): 332 passing.
- Frontend (vitest): 179 passing.
- Frontend (Playwright fixture E2E): 50 passing.
- Frontend (Playwright production smoke): 6 passing.
- `tsc --noEmit` clean on both the frontend and workers packages.
- `eslint .` clean.
- ABI manifest parity: `ABI-OK`.

## Known external blockers (not fixable from this codebase alone)

1. **Pyth Lazer API key** -- required for any real oracle price, which
   gates every session-signed trade and the market's own "Open" trading
   path. `PYTH_PRO_API_KEY` is unset everywhere in this environment;
   anonymous access to the documented Lazer WSS endpoints is refused
   (HTTP 403 at handshake, confirmed directly).
2. **Real Privy app credentials** -- `PRIVY_APP_ID`/`PRIVY_APP_SECRET` are
   unset; the relayer's Privy-dependent identity check is verified by unit
   tests and by the deployed Worker correctly returning
   `503 privy_unconfigured` rather than falsely accepting, but the real
   round trip is untested.
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
