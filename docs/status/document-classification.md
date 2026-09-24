# Documentation classification

This index prevents historical notes from being mistaken for current protocol
authority. `docs/status/current.md` remains the authoritative implementation
snapshot; the documents below are grouped by how they should be used.

## Canonical specifications

These describe current interfaces, invariants, or architecture and should be
updated when the implementation changes.

| Document | Scope |
|---|---|
| `architecture.md` | System boundaries and component architecture |
| `custody.md` | L1 custody, vault, reconciliation, and withdrawal invariants |
| `events.md` | Event ABI and payload formats |
| `frontend-architecture.md` | Frontend structure and data boundaries |
| `indexer.md` | Indexer data model and ingestion boundaries |
| `oracle.md` | Oracle verification and market-clock rules |
| `orderbook.md` | Patricia order-book representation and matching invariants |
| `program-layout.md` | On-chain account layout and size constraints |
| `risk.md` | Margin, exposure, funding, and liquidation rules |
| `security.md` | Security invariants and trust boundaries |
| `sessions.md` | Trading-session authorization and nonce rules |
| `settlement-scratch.md` | Settlement scratch-account ABI |
| `transports.md` | L1/ER transport and signer boundaries |
| `worker.md` | Worker API, persistence, and runtime boundaries |

## Operational runbooks

These are procedures and verification guides, not substitutes for the
specifications above.

| Document | Scope |
|---|---|
| `devnet-configuration.md` | Devnet accounts, endpoints, and environment setup |
| `pyth-ops.md` | Pyth catalog, entitlement, and incident procedure |
| `accessibility.md` | Frontend accessibility verification |

## Historical, research, or superseded design records

These preserve reasoning and prior decisions. They are evidence, not current
authority, unless `docs/status/current.md` explicitly cites them.

| Document | Scope |
|---|---|
| `magicblock.md` | MagicBlock integration research and prior findings |
| `sbpf-compatibility.md` | SBPF compatibility investigation |

`README.md` is the navigation map for this directory. New status evidence
belongs under `docs/status/`; dated evidence files should not be silently
rewritten.
