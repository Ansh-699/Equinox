# TypeScript client and ABI

`clients/equinox/` is the in-repo TypeScript interface to the [Solana program](../../programs/equinox/README.md). It is not a separately published npm package. The frontend and scripts import its builders and decoders so transaction layouts have one client-side source.

| Area | Files |
| --- | --- |
| Program identity and exported API | `src/constants.ts`, `src/index.ts` |
| V3 accounts and PDA derivation | `src/abi/v3.ts`, `src/abi/pda.ts` |
| Instruction builders | `src/abi/v3-instructions.ts`, `order-instructions.ts`, `custody-instructions.ts`, `session-instructions.ts` |
| Event and book decoding | `src/abi/event-decoders.ts`, `src/abi/orderbook.ts` |
| Layout and wire fixtures | `src/abi/layout.json`, `fixtures/instructions.json` |

The deployment's public addresses and market list come from [`config/equinox-deployment.json`](../../config/equinox-deployment.json). The Rust program defines the authoritative account and instruction layout. Do not change a client offset by inspecting one live account in isolation.

## Updating the ABI

When the Rust layout or instruction wire format changes, update the program and client together. From the repository root:

```bash
npm run generate:equinox-abi   # write layout.json from the Rust manifest test
npm run check:equinox-abi      # compare the committed layout with Rust
npm run check:v3-layout-fixture
```

`src/abi/*.test.ts` and the Rust instruction/layout tests provide parity examples. The [program guide](../../programs/equinox/README.md) explains the account model; the [current status](../../docs/status/current.md) identifies what is actually deployed on devnet.
