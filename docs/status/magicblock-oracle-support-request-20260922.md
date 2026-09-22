# MagicBlock oracle compatibility request — TSLA feed 1435

This is a read-only support package. It authorizes no transaction.

## Observed Devnet state

- Oracle program: `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`
- Feed PDA: `8L7ccCxTBZaLsMMdhAod5fFnpdEWGSDPW4y1td7y3y8N`
- Feed: `Equity.US.TSLA/USD`, numeric ID `1435`
- Catalog channel: `fixed_rate@50ms`, channel ID `2`
- Catalog exponent: `-5`
- Account length: `144` bytes
- ER owner: `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`
- Latest observed ER exponent: `5`
- Latest observed verification level: `1`

The account updates in ER, but its exponent does not match the catalog and
the account has no StockStream channel, market-session, trading-status,
sequence, or authenticated-snapshot fields.

## Provenance

Historical initialization transaction:

`2RemknQvzQ45Qs5SexhC63ZCfxU5S1jKFwRnpJZGVoMNFGxUZqLUhioweQwSo7PvBHFC4U5GRhUmtckeZSkANADF`

The decoded initialization argument contained exponent `8`. The upstream
oracle source at commit
`c6d08ac317706c0943e9b6304b915cd1064bbea3`
writes the supplied exponent directly and preserves it on updates.

## Required clarification

Please provide one of:

1. Confirmation that feed 1435 was initialized incorrectly, followed by a
   validator-supported reinitialization with exponent `-5` and a documented
   migration procedure; or
2. The exact deployed wire version and transformation that explains the
   observed exponent `5`, including the canonical way a consumer should
   validate the catalog exponent; or
3. A supported ER adapter that exposes authenticated channel, exponent,
   confidence, publication time, market session, trading status, and sequence
   fields without requiring StockStream to write Pyth treasury, storage, fee,
   or payer accounts.

Until one of these is supplied, StockStream rejects the account and does not
delegate, authorize sessions, place orders, match fills, commit, restore, or
withdraw.

Evidence: `docs/status/magicblock-oracle-probe-20260922.json`.
