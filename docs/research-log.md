# Equinox External Research Log

All external decisions and URLs in one file. Every entry was verified during
implementation, not from memory.

## MagicBlock Ephemeral Rollups

| Topic | Source (official) | Date | Decision |
|---|---|---|---|
| Delegation Program API, seeds, commit frequency | https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/local-development | 2026-09-17 | Delegation via owner-program CPI; commit_frequency_ms is a delegation arg |
| getBlockhashForAccounts (account-aware routing) | https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getBlockhashForAccounts | 2026-09-17 | Must use the router, not the standard RPC, for ER domain transactions |
| getDelegationStatus | https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getDelegationStatus | 2026-09-17 | Read-only per-account delegation status from the router |
| Fees and commit economics (100k/account/commit from 26, 300k session, no-fee-payer 10-commit ceiling) | https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics | 2026-09-17 | Dual fee model: deposit-based session charge + live per-commit fee from commit 26 with fee payer |
| Runtime limits (64KB tx on ER) | https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits | 2026-09-17 | Account size max 10MiB; 64KB tx on ER; 200k CU per ix |
| Delegation Program source (delegate.rs, undelegate.rs) | https://github.com/magicblock-labs/delegation-program (processor/fast/) | 2026-09-17 | Exact account order, signer flags, external-undelegate wire format |
| Magic Program source (ScheduleIntentBundle) | https://github.com/magicblock-labs/magicblock-program | 2026-09-17 | Commit intent encoding |
| `dlp_api` =3.1.0, `magic-program-api` =0.10.1 (crates.io) | pinned crates | current | Constants, PDA tags, delegate args encoding verified byte-for-byte |
| MagicBlock Pyth real-time pricing oracle | https://github.com/magicblock-labs/real-time-pricing-oracle | 2026-09-17 | Pattern for ER-domain oracle feed read (not used yet; future work) |

## Pyth Pro

- Subscribe to prices: https://docs.pyth.network/price-feeds/pro/subscribe-to-prices (2026-09-17)
  Three endpoints mandatory: wss://pyth-lazer-{0,1,2}.dourolabs.app/v1/stream
  Bearer-token auth for server-to-server; JWT via /auth/token for browser (subprotocol `pyth-lazer-auth`)
- API reference (WebSocket protocol): https://pyth-lazer.dourolabs.app/docs (types from sdk/js/src/protocol.ts in pyth-network/pyth-lazer-public)
  `ignoreInvalidFeeds` is the canonical server field (alias `ignoreInvalidFeedIds`)
  PriceFeedProperty enum has NO `tradingStatus` property — confirmed by sdk source
- Payload Reference: https://docs.pyth.network/price-feeds/pro/payload-reference
  `feedUpdateTimestamp` mandatory for freshness; `bestBidPrice`/`bestAskPrice` experimental
- Risk/analytics subscription split: documented in docs/pyth-ops.md §3

## Solana

- Clusters: https://solana.com/docs/core/clusters (devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`)
- RPC: https://solana.com/docs/rpc (sendTransaction, getLatestBlockhash, confirmTransaction)
- WebSocket: https://solana.com/docs/rpc/websocket
- Program deploy: BPFLoaderUpgradeable, programdata layout (4+8+1+32-byte header), ELF length from section headers

## Privy

- Solana getting started: https://docs.privy.io/recipes/solana/getting-started-with-privy-and-solana
- Sign a message/transaction: https://docs.privy.io/wallets/using-wallets/solana/sign-a-message
- Auth token verification: https://docs.privy.io/guide/server/authorization/verification
- Privy is behind the `WalletBoundary` interface; live credentials still pending

## Build/deployment facts (measured, not researched)

- Agave 4.2.1 toolchain (solana-cli 4.2.1, cargo-build-sbf 4.1.0, platform-tools v1.54)
- ELF length: NOT the loader's `Data Length` field — compute from section headers (e_shoff + e_shnum × e_shentsize)
- System Program `allocate` rejects lamports-bearing accounts: fund AFTER allocate, not before
- Inner-instruction realloc cap: 10,240 bytes — the market PDA is grown incrementally
- solana program deploy `--keypair` is the PROGRAM-ID keypair, not the fee payer; use `--program-id <path>` explicitly
- Devnet genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
