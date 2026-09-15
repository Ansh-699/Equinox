# StockStream Architecture

StockStream is a generic multi-market perpetual CLOB. An exchange registry owns
instrument definitions; each `PerpMarket` owns its own arenas, seats, event ring,
vault configuration, oracle policy, risk parameters and delegation state.

L1 owns configuration, custody and authorities. MagicBlock ER owns delegated
hot state. ER acceptance and an L1 commit are separate states in every client
and indexer projection. Runtime execution and live external verification remain
unverified in the current environment.
