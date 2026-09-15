# Oracle

Pyth Pro/Lazer is the sole production risk oracle. The keeper is server-only,
requests Solana-format signed payloads and places Ed25519 verification before
the consumer instruction. Per-market feed, channel, exponent, confidence,
freshness, session and trading status are configuration, not browser input.
`PYTH_PRO_API_KEY` is not present in source or bundles; authenticated catalog
and signed AAPL verification are externally blocked.
