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
| `authentication.md` | Authentication and authorization contracts |
| `client-sdk.md` | Client instruction and account usage |
| `custody.md` | L1 custody, vault, reconciliation, and withdrawal invariants |
| `events.md` | Event ABI and payload formats |
| `frontend-architecture.md` | Frontend structure and data boundaries |
| `indexer.md` | Indexer data model and ingestion boundaries |
| `keepers.md` | Keeper responsibilities and safety gates |
| `market-registry.md` | Market and instrument registry model |
| `oracle.md` | Oracle verification and market-clock rules |
| `orderbook.md` | Patricia order-book representation and matching invariants |
| `program-layout.md` | On-chain account layout and size constraints |
| `risk.md` | Margin, exposure, funding, and liquidation rules |
| `security.md` | Security invariants and trust boundaries |
| `sessions.md` | Trading-session authorization and nonce rules |
| `settlement.md` | Atomic settlement and rollback behavior |
| `settlement-scratch.md` | Settlement scratch-account ABI |
| `transports.md` | L1/ER transport and signer boundaries |
| `worker.md` | Worker API, persistence, and runtime boundaries |

## Operational runbooks and release gates

These are executable procedures or pre-release checklists, not substitutes for
the specifications above.

| Document | Scope |
|---|---|
| `devnet-configuration.md` | Devnet accounts, endpoints, and environment setup |
| `live-devnet-runbook.md` | Resumable live Devnet lifecycle procedure |
| `pyth-ops.md` | Pyth catalog, entitlement, and incident procedure |
| `security-review-preparation.md` | Audit-readiness and evidence checklist |
| `stockstream-build-record.md` | Reproducible build and artifact verification |
| `stockstream-devnet-release-gate.md` | Devnet release acceptance gate |
| `testing.md` | Test commands and verification scope |
| `abi-handoff-checklist.md` | ABI handoff and rebase checklist |
| `accessibility.md` | Frontend accessibility verification |

## Historical, research, or superseded design records

These preserve reasoning and prior decisions. They are evidence, not current
authority, unless `docs/status/current.md` explicitly cites them.

| Document | Scope |
|---|---|
| `frontend-build-diagnostics.md` | Historical production-build investigation |
| `magicblock-economics-redesign.md` | Design comparison and economics research |
| `magicblock.md` | MagicBlock integration research and prior findings |
| `phase-2-external-references.md` | External concept references |
| `research-log.md` | External research log |
| `sbpf-compatibility.md` | SBPF compatibility investigation |
| `stockstream-roadmap.md` | Prioritized roadmap and planning record |
| `stockstream-separation-report.md` | Historical separation analysis |

`README.md` is the navigation map for this directory. New status evidence
belongs under `docs/status/`; dated evidence files should not be silently
rewritten.
