# TSLA ER oracle bridge deployment gate

This is a preparation-only runbook. It authorizes no transaction and must not
be used against the currently delegated TSLA market.

## Migration boundary

The deployed TSLA program predates `CreateOracleSnapshotV3` (opcode 59) and
`UpdateOracleSnapshotV3` (opcode 58). The current delegated core
`Bm2MAXgJJRreSM9x5inv84NtraTuacVDmKZ1yyeu2ESU` must not be upgraded or reused.
A compatible rollout requires a new program ID, new upgrade authority, fresh
exchange/instrument/core, fresh 27-account execution bundle, and a fresh
snapshot PDA. No existing AAPL, legacy, or preserved core may appear in the
new bundle.

## Required preflight

Before any deployment or account creation, independently verify:

1. The new ELF hash is computed from the exact source checkpoint and contains
   opcodes 58 and 59.
2. The new program ID and upgrade authority are distinct from all historical
   programs and authorities.
3. TSLA Pyth entitlement is available for feed 1435, channel 2, exponent -5.
4. The deployment wallet, market authority, and snapshot writer authority are
   funded and explicitly identified.
5. The MagicBlock ER endpoint and validator are the configured ones.
6. The 27-account derivation has no aliases and excludes every Pyth account.

## Fresh-market sequence

All transactions must be simulated individually and then as a complete plan;
the plan must stop on any identity, owner, size, or writable-flag mismatch.

1. Deploy the new program and verify executable status and ELF hash.
2. Create exchange and instrument with TSLA metadata.
3. Create and initialize the V3 core, pages, seat shards, and event shards.
4. Create the 128-byte `OracleSnapshotV3` PDA while the core is
   Equinox-owned.
5. Activate the core and create the trader seat.
6. Submit the canonical L1 Pyth verification into the snapshot using:
   `[snapshot(w), core(ro), payer(signer,w), Pyth(ro), storage(ro),
   treasury(w), system(ro), instructions-sysvar(ro)]`.
7. Read the snapshot back and require authenticated=true, sequence=1, fresh
   timestamp, feed 1435, channel 2, exponent -5, open market status, and
   valid confidence.
8. Deposit collateral on L1 before delegation.
9. Delegate only the 27 execution accounts to MagicBlock ER. Never delegate
   the snapshot, Pyth storage, treasury, payer, vault, or fee accounts.
10. Read the snapshot through ER as readonly and re-check the 10-second
    freshness gate.
11. Only after that read-through succeeds may session authorization and ER
    order testing be considered for separate approval.

The opcode-59 snapshot-allocation instruction has the canonical four-account
ABI `[core(ro), snapshot(w), payer(signer,w), system_program(ro)]`. The
System Program is required by the PDA allocation CPI; Pyth storage, treasury,
fee, and verification accounts are not part of this instruction.

## Abort conditions

Abort without sending if the snapshot is absent, writable, foreign-owned,
stale, replayed, wrong-feed, wrong-channel, wrong-exponent, or not visible
through ER. Abort if any Pyth treasury/storage/payer account appears in the ER
bundle, or if the old program/core/account set appears in any fresh-market
transaction.

## Current evidence

The local implementation and tests are complete. The live read-only probe at
`docs/status/tsla-er-oracle-readthrough-20260922.json` shows the delegated
core on L1 and ER but no snapshot account on either endpoint. Therefore this
runbook is not an approval to deploy and live ER trading remains unverified.
