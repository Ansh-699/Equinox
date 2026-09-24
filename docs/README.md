# Equinox documentation map

[Project overview](../README.md) · [Frontend guide](../app/README.md) ·
[Program guide](../programs/equinox/README.md) ·
[Client guide](../clients/equinox/README.md) ·
[Market API guide](../workers/README.md) ·
[Market-maker guide](../services/market-maker/README.md)

`docs/status/current.md` is the current-state snapshot. Older sections inside
it record prior findings; its top dated summary takes precedence.

| Class | Documents |
| --- | --- |
| Canonical architecture and protocol | `architecture.md`, `program-layout.md`, `orderbook.md`, `events.md`, `settlement-scratch.md`, `custody.md`, `risk.md`, `sessions.md`, `oracle.md`, `indexer.md`, `transports.md`, `worker.md`, `frontend-architecture.md`, `security.md` |
| Operational guides | `devnet-configuration.md`, `pyth-ops.md`, `accessibility.md` |
| Compatibility notes | `sbpf-compatibility.md` |
| Historical integration notes | `magicblock.md` |
| Authoritative live evidence | `status/current.md`, `status/devnet-lifecycle-evidence-20260919.json`, `status/magicblock-commit-simulation-20260919.json`, `status/magicblock-v3-commit-size-evidence-20260920.json`, `status/v3-recovery-evidence-20260920.json`, `status/v3-sharded-commit-evidence-20260920.json` |

When a historical document conflicts with `status/current.md`, the status
snapshot and its linked evidence win. New live claims must include a command,
signature/slot where applicable, and a dated evidence artifact.
