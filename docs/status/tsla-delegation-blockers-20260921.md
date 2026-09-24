# TSLA delegation approval withdrawn pending ABI and custody review

Inspected source: `cddaa316e7a655b5bb0b27e423f7a3a1f95a377d`.
Read-only Devnet snapshot: slot `501905949`.
No transaction was submitted during this review.

## Validator and risk storage overlap

`programs/equinox/src/v3.rs` defines the 32-byte validator at offset
214, occupying bytes 214–245. Initial margin, maintenance margin,
liquidation fee, maker fee, taker fee, and maximum leverage occupy bytes
218–231. `delegate_v3_account` in `magicblock.rs` writes the validator
before copying the core into its delegation buffer.

Applying that exact write to a copy of the live TSLA core using validator
`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` changes:

| Field | Live before | Projected after validator write |
|---|---:|---:|
| Initial margin bps | 2000 | 31363 |
| Maintenance margin bps | 1000 | 3254 |
| Maker fee bps | 0 | 50335 |
| Taker fee bps | 5 | 19144 |

These are local byte projections, not submitted or simulated post-state
readbacks. The current checked risk reader rejects fees above 1000 bps.
The prior successful opcode-48 simulation proves the delegation instruction
can execute, not that it preserves usable risk configuration.

Do not submit the previously proposed delegation transaction. Resolving
the overlap requires an ABI-compatible migration design, regression tests,
and deployment review; changing only the client cannot fix the program write.
No protocol source, deployment, or account migration was performed here.

## L1 custody ordering

`deposit_collateral_v3` requires the core to be Equinox-owned and
explicitly rejects Delegated or Undelegating status. Thus the proposed
delegate → L1 deposit sequence is unsupported by the current source.
Seat/custody preparation and test collateral funding must be reviewed
before delegation, or a separately designed custody mechanism is required.
Do not delegate a token vault to work around this constraint.

## Oracle freshness

Live readback still records `oracle_valid=true`, feed 1435, channel 2,
exponent -5, and publish timestamp 1789992266. At inspection the update
was 2005 seconds old. This proves historical acceptance, not current
freshness. A future approved oracle update must use a new real payload.

The fresh program was executable; TSLA exchange, instrument and core
existed under the expected program. The local artifact SHA-256 remained
`c878d70b13864c6a8d51170a67129867e64484bec8395ae455fa3c6132014b97`.
This review did not redump the deployed ELF or rerun a full verification gate.
