# Settlement Scratch Account

`PlaceOrder` uses a per-market, per-seat working account instead of putting the
bounded settlement plan on the SBF stack. The canonical PDA seeds are
`[b"settlement", market_pubkey, trader_seat_index_le_bytes]`. This keeps active
traders independent and avoids a global settlement lock.

The account is StockStream-owned, writable, exact-length, versioned, and bound
to its market, trader public key, and seat index. It is distinct from the market
account and signer. `InitializeSettlementScratch` requires the trader signer
and validates this binding. Account creation funding and System Program CPI are
reserved for the runtime lifecycle milestone; the current program validates an
already allocated program-owned PDA of the exact length.

The fixed layout consists of a 266-byte header, a `PlannedMatch` region, five
`TraderSeat` result slots (taker plus at most four makers), and four fill-event
slots. The total length is derived from Rust type sizes and alignment in
`scratch.rs`; it is bounded below 12 KiB. No full plan is returned by the
production planner or allocated as a handler local.

Within one instruction the status transitions are `Empty -> Planning -> Ready
-> Empty`. `Ready` is internal only: there is no public apply instruction, and
successful execution clears all transient plan bytes. A failed transaction is
rolled back by the Solana runtime together with the scratch account. Future
MagicBlock delegation must include the trader's scratch PDA with that trader's
hot state and reject non-empty scratch state at a commit boundary.
