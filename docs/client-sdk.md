# Client SDK

The SDK owns canonical program IDs, little-endian instruction encoding, account
metadata and range validation. `StockStreamProtocolService` composes seat,
scratch, custody, order and cancellation instructions over injected wallet,
RPC and Magic Router transports. It never fabricates signatures and requests
an account-aware ER blockhash.
