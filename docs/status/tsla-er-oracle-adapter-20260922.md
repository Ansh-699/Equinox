# TSLA ER oracle-domain audit (2026-09-22)

No live state was mutated by this change. The delegated TSLA core and all 27
execution accounts were left untouched.

## Existing integration

The repository had one canonical Pyth Lazer verifier. `ConsumeOracleUpdateV3`
is explicitly L1-only: it writes the delegated core/event shards and requires
Pyth storage and treasury accounts. The Worker keeper uses an L1 transport and
there is no MagicBlock Oracle Adapter, ER oracle bridge, or sponsored Pyth
verification path. The relayer sponsor intentionally rejects arbitrary system
instructions, so funding a session signer does not solve the domain mismatch.

The exact Pyth accounts are the configured Pyth program, the Pyth storage
account (read-only), the storage-referenced treasury (writable), the system
program, and the instructions sysvar. The treasury and storage are not in the
27-account delegated bundle and must remain L1-only.

## Implemented local bridge (Option A)

This checkpoint adds an authenticated, L1-owned `OracleSnapshotV3` layout and
an `UpdateOracleSnapshotV3` instruction (opcode 58). Pyth verification uses
the same Ed25519/instructions-sysvar checks and Pyth `verify_message` CPI as
the canonical path, then writes only the Equinox snapshot. The snapshot
is intended to be passed read-only to ER execution; no Pyth account is
delegated or writable in the execution bundle.

Layout (`STKORS03`, version 3, 128 bytes):

| field | start | end | size |
|---|---:|---:|---:|
| discriminator | 0 | 7 | 8 |
| version / initialized | 8 | 10 | 3 |
| core | 12 | 43 | 32 |
| feed ID | 44 | 47 | 4 |
| channel | 48 | 48 | 1 |
| exponent | 49 | 52 | 4 |
| price | 53 | 60 | 8 |
| confidence | 61 | 68 | 8 |
| publish timestamp | 69 | 76 | 8 |
| sequence | 77 | 84 | 8 |
| session / trading status / authenticated | 85 | 87 | 3 |
| snapshot revision | 88 | 88 | 1 |

The writer binds the snapshot to the core's feed ID, channel and exponent,
preserves price, confidence, feed timestamp, session/status, and rejects wrong
feed, channel, exponent, future, stale, invalid-confidence and unauthenticated
updates. Session values 0–2 map to Open; 3–4 map to Closed/close-only. The
10-second freshness rule remains enforced by the snapshot validator.
The snapshot writer is additionally required to sign as the core's configured
market authority; a valid Pyth message from an arbitrary payer is rejected.

## Option assessment

- **A — L1 Pyth update + ER read-only snapshot:** source support is now present
  locally. It is not deployed and no ER read-through simulation has been run.
- **B — L1 update followed by delegation:** existing source cannot safely use
  the canonical Pyth instruction after delegation because Pyth treasury/fee
  accounts are not delegated. It remains unsupported for the current market.
- **C — MagicBlock Oracle Adapter/bridge:** no existing adapter was found; the
  new opcode is the smallest local authenticated snapshot bridge, not a claim
  of MagicBlock validator support.
- **D — sponsored Pyth verification:** no sponsor path exists in the current
  Worker/relayer. A future sponsor must be explicitly allowlisted and must pay
  only the L1 verifier transaction.

The snapshot account and any execution-path read-through require a new program
deployment and fresh market accounts; the currently deployed program is not
mutated. The local writer accepts a read-only core owned either by Equinox
or the canonical MagicBlock delegation program, so an L1 snapshot refresh is
source-compatible with a delegated core. That ownership path is not yet live
verified. Until a new deployment and ER read-through simulation prove this
path, session authorization and live orders remain blocked.

The exact snapshot-update metas are `[snapshot(w), core(ro), payer(signer,w),
pyth_program(ro), storage(ro), treasury(w), system(ro), instructions_sysvar(ro)]`.
For V3 ER instructions the snapshot is appended after the existing bundle and
session metas, remains read-only, and is never delegated. The Rust reader now
validates an optional snapshot before order, replacement, funding, liquidation,
and session-authorization risk paths; callers without one retain the prior
core-freshness compatibility path.
The Worker also has a read-only base64 RPC reader that can target L1 or an ER
endpoint; it never constructs or submits transactions.

The fresh 128-byte snapshot account requires approximately `0.00130048 SOL`
rent-exempt balance at the current Devnet rent rate, plus normal transaction
fees. No such account has been created on Devnet yet.

The read-only TSLA entitlement smoke subsequently observed 3/3 subscribed
endpoints and accepted redacted updates for feed 1435 at `fixed_rate@50ms`.
This proves the Pyth stream is available; it does not prove an on-chain
snapshot update or ER read-through. Evidence:
`docs/status/tsla-pyth-smoke-20260922.json`.

Read-only Devnet/ER probe: the derived snapshot PDA is
`5QAoerLKvoAfbqw13pLuqcfKZHMeDtQGb7LCscZE3HVb`. The delegated TSLA core is
readable on both L1 and ER, but the snapshot is absent on both domains, so a
fresh snapshot read-through cannot yet be claimed. Evidence:
`docs/status/tsla-er-oracle-readthrough-20260922.json`.

Local evidence: Rust snapshot tests (4), targeted V3/oracle/session tests,
client ABI/facade tests (45 total in the targeted run), Worker tests (43),
frontend suite (225), and the full Worker suite (357), SBF build, ABI parity
(including generated snapshot offsets), secret scan, and diff checks pass.
The native V3 bundle suite now also has a read-only ER-boundary simulation that
accepts a fresh snapshot and proves the snapshot account is not writable and no
Pyth accounts are present. This is a local execution-domain test, not a live
MagicBlock validator result.
The full strict Clippy gate is not clean because the existing repository emits
107 unrelated warnings/errors; no broad lint rewrite was made.
