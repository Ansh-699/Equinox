# Pyth entitlement request

Please grant the authorized Pyth Pro Lazer application access to the following
feed and channel:

- Feed: `Equity.US.AAPL/USD`
- Numeric feed ID: `922`
- Channel: `fixed_rate@50ms`
- Solana payload channel ID: `2`
- Catalog exponent: `-5`
- Required redundancy: at least two authenticated streams
- Network/application: Equinox Devnet test environment

Current evidence: all three configured Lazer endpoints reject subscriptions for
feed `922` with `Not entitled: no grant accepts this feed (asset type
'equity', instrument type 'spot', exchange 1)`. No payload was submitted.

After entitlement is granted, rerun the server-only smoke probe:

```bash
NO_DNA=1 node --env-file=.env.local scripts/pyth-live-smoke.mjs
```

Proceed only when at least two streams subscribe and produce redacted updates.
Do not place a transaction or fabricate an oracle message while the probe is
below that redundancy floor.
