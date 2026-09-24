# Devnet Configuration

Public development endpoints verified against the current provider
documentation:

- Solana RPC: `https://api.devnet.solana.com`
- Solana WebSocket: `wss://api.devnet.solana.com/`
- Magic Router: `https://devnet-router.magicblock.app`
- MagicBlock Asia ER: `https://devnet-as.magicblock.app`
- MagicBlock Asia validator: `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`

Circle's official Solana Devnet USDC mint is
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` with 6 decimals and the
legacy SPL Token program. It is testnet USDC with no financial value; custody
still requires a successful on-chain CPI journey before being marked verified.

The MagicBlock docs list the same validator identity for Asia devnet and the
Router `getIdentity` response. `commit_interval_ms` remains Equinox's
30,000 ms setting.

Pyth Pro's current Solana contract is
`pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt`; its documented storage and
treasury accounts are `3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL` and
`Gx4MBPb1vqZLajZmsKLg8fGw9ErhoKsR8LeKcCKFyak`. A feed ID and API key must be
verified separately through the authenticated Pyth Pro catalog. The checked-in
fixtures intentionally do not mark any feed live.

Deployment remains blocked until the program keypair corresponding to the
pinned Equinox program ID is available. The wallet keypair is funding and
upgrade authority material; using it as the program keypair would deploy a
different program address and fail Equinox's program-ID check.
