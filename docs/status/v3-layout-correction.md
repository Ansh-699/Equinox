# Proposed V3 risk-layout revision 2 (local only)

The validator offset comes from Equinox's existing delegation encoder and
validator-binding reader in `magicblock.rs`, not a guessed DLP discriminator.
Endpoints and instruction bytes are unchanged. End offsets below are inclusive.

| Field | Start | End | Size | Owner | Writable by delegation |
|---|---:|---:|---:|---|---|
| Discriminator | 0 | 7 | 8 | Equinox | no |
| Layout version, initialized, mode | 8 | 11 | 4 | Equinox | no |
| Instrument, authority, mint, token program | 12 | 139 | 128 | Equinox | no |
| Order/event sequences | 140 | 155 | 16 | Equinox | no |
| Funding accumulator/time | 156 | 179 | 24 | Equinox | no |
| Oracle valid, price, timestamp | 180 | 196 | 17 | Equinox | no |
| Delegation status | 197 | 197 | 1 | Equinox lifecycle | yes |
| Expected commit sequence | 198 | 205 | 8 | Equinox lifecycle | yes |
| Last committed sequence | 206 | 213 | 8 | Equinox lifecycle | no |
| Explicit validator overlay | 214 | 245 | 32 | Equinox MagicBlock integration | yes |
| Oracle feed/channel/exponent | 246 | 254 | 9 | Equinox | no |
| Padding | 255 | 255 | 1 | reserved | no |
| Position/open-interest limits and current interest | 256 | 303 | 48 | Equinox | no |
| Mark deviation | 304 | 305 | 2 | Equinox | no |
| Protocol fees, insurance, bad debt, vault liability | 306 | 369 | 64 | Equinox | no |
| Reconciliation, risk-layout revision | 370 | 371 | 2 | Equinox | no |
| Commit phase, padding, epoch, child count, padding | 372 | 391 | 20 | Equinox | no |
| 26 child commit records | 392 | 1639 | 1248 | Equinox | no |
| Vault surplus, withdrawal buffer | 1640 | 1671 | 32 | Equinox | no |
| Initial margin (old 218–219) | 1672 | 1673 | 2 | Equinox | no |
| Maintenance margin (old 220–221) | 1674 | 1675 | 2 | Equinox | no |
| Liquidation fee (old 222–223) | 1676 | 1677 | 2 | Equinox | no |
| Maker fee (old 224–225) | 1678 | 1679 | 2 | Equinox | no |
| Taker fee (old 226–227) | 1680 | 1681 | 2 | Equinox | no |
| Leverage (old 228–231) | 1682 | 1685 | 4 | Equinox | no |
| Accepted provider session | 1686 | 1686 | 1 | verified oracle ingestion | no |
| Accepted confidence | 1687 | 1694 | 8 | verified oracle ingestion | no |
| Reserved | 1695 | 4095 | 2401 | reserved | no |

The fixed account size remains 4096 and the V3 discriminator remains STKMK003.
Risk-layout revision at byte 371 changes from 1 to 2: this is NOT wire-compatible
for risk fields. Existing revision-1 accounts must not be interpreted using the
new risk offsets or delegated by the corrected implementation. No live migration
is authorized. Fresh accounts with revision 2, preferably under a separately
reviewed new program ID, are the deployment boundary; replacing client offsets
alone cannot correct the deployed program.

## Old (revision 1) risk offsets for contrast

| Field | Old start | Old end | Overlapped by validator 214–245 |
|---|---:|---:|---|
| Initial margin bps | 218 | 219 | yes |
| Maintenance margin bps | 220 | 221 | yes |
| Liquidation fee bps | 222 | 223 | yes |
| Maker fee bps | 224 | 225 | yes |
| Taker fee bps | 226 | 227 | yes |
| Maximum leverage | 228 | 231 | yes |
| Validator overlay | 214 | 245 | source of the collision |

Applying the exact validator write to a live revision-1 copy changed maker fee
`0 → 50335` bps and taker fee `5 → 19144` bps; the checked risk reader rejects
fees above 1000 bps. That byte projection is preserved as a non-suppressed
regression test (`legacy_overlap_is_reproduced_not_suppressed`).

## Local verification evidence (not deployed)

- `cargo test -p equinox`: all suites pass, including
  `v3_layout_overlay` (collision reproduction, overlay byte-isolation,
  round-trip, revision-1 rejection, freshness matrix).
- `websocket smoke`: `NO_DNA=1 node --env-file=.env.local
  scripts/pyth-live-smoke.mjs` → 3/3 endpoints subscribed, fresh TSLA feed
  `1435` updates received, payloads redacted.
- `npm run check:equinox-abi` → ABI-OK.
- `npm run check:v3-layout-fixture` → the committed
  `clients/equinox/src/abi/v3-core-revision2.hex` byte-for-byte equals the
  Rust-produced revision-2 core after the validator overlay.
- `npm test` → 218 passed; `workers` → 355 passed; `tsc --noEmit` clean.
- `cargo build-sbf` + `verify-sbf-artifact.py` → loadable Equinox SBF.
- `npm run lint`, `secret-scan.sh`, `git diff --check` → clean.

## Deployment risks still open

1. Revision 2 is not wire-compatible for risk fields. The deployed revision-1
   TSLA core must never be delegated or risk-read by the corrected program.
2. Client/Worker decoders now reject revision 1; shipping them ahead of a
   revision-2 core would hide the currently live revision-1 TSLA market.
3. `V3_MAX_ORACLE_AGE_SECONDS = 10` requires a fresh accepted update before
   every risk-sensitive action; the runner must sequence the keeper update
   accordingly or operations will fail closed.
4. Program upgrade authority, new program ID decision, and fresh-account
   creation remain unreviewed and unauthorized.
