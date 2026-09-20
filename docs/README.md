# StockStream documentation map

`docs/status/current.md` is the authoritative current-state snapshot. The
remaining documents are classified here so historical design notes are not
mistaken for live guarantees.

| Class | Documents |
| --- | --- |
| Canonical architecture and protocol | `architecture.md`, `program-layout.md`, `orderbook.md`, `events.md`, `settlement.md`, `settlement-scratch.md`, `custody.md`, `risk.md`, `sessions.md`, `market-registry.md`, `transports.md`, `client-sdk.md`, `worker.md`, `frontend-architecture.md`, `authentication.md`, `security.md` |
| Operational runbooks | `live-devnet-runbook.md`, `devnet-configuration.md`, `keepers.md`, `pyth-ops.md`, `testing.md`, `stockstream-devnet-release-gate.md`, `abi-handoff-checklist.md` |
| Build and release records | `stockstream-build-record.md`, `sbpf-compatibility.md`, `frontend-build-diagnostics.md`, `security-review-preparation.md` |
| Historical or superseded design | `magicblock-economics-redesign.md`, `magicblock.md`, `stockstream-separation-report.md`, `stockstream-roadmap.md` |
| Research | `research-log.md`, `phase-2-external-references.md`, `research/backpack-stock-market-reference.md` |
| Authoritative live evidence | `status/current.md`, `status/devnet-lifecycle-evidence-20260919.json`, `status/magicblock-commit-simulation-20260919.json`, `status/magicblock-v3-commit-size-evidence-20260920.json`, `status/v3-recovery-evidence-20260920.json`, `status/v3-sharded-commit-evidence-20260920.json` |

When a historical document conflicts with `status/current.md`, the status
snapshot and its linked evidence win. New live claims must include a command,
signature/slot where applicable, and a dated evidence artifact.
