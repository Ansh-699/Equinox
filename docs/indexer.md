# Indexer

Indexing is per market and per domain (`l1` or `er`). Cursors advance only on
contiguous sequences; duplicates are idempotent and gaps require snapshot
resynchronization. ER state is never treated as L1 finality, and indexer data
is never an oracle or risk authority.
