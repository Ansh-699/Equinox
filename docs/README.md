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
| Live status | `status/current.md` (and `status/devnet-e2e-lifecycle-20260923.json`, read by the demo config) |

When a historical document conflicts with `status/current.md`, the status
snapshot wins. New live claims should include the command and the
signature or slot that shows them.
