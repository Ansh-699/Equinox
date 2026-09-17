# Trading Sessions

Privy application sessions and onchain trading sessions are independent. A
scoped session signer may `PlaceOrder`, `CancelOrder`, `CancelAll`,
`ReplaceOrder`, and reduce-only-flagged `PlaceOrder` calls. It can never
deposit, withdraw, consume an oracle update, delegate/commit/undelegate a
market, change authorities, or run an emergency action -- those handlers
check the transaction's actual signer against a stored authority
(`market_authority`, `seat.trader`, ...) that a session signer's pubkey never
matches, so a session can't reach them regardless of its own allowlist.

## Account

`session::TradingSession` is a dedicated, versioned PDA -- not bytes borrowed
from `TraderSeat` -- derived as:

```
["trading_session", owner, market, seat_index_le, session_signer]
```

under the StockStream program ID (`session::derive_trading_session` in Rust,
`deriveTradingSession` in TypeScript; the two are verified byte-for-byte
identical for the same inputs in
`programs/stockstream/tests/trading_session.rs` and
`clients/stockstream/src/index.test.ts`). 256 bytes, `#[repr(C, packed(1))]`
with a compile-time size assertion. `AuthorizeTradingSession` creates it via
a real `CreateAccount` System Program CPI signed with the PDA's own derived
seeds (a PDA cannot sign a top-level client transaction, so the client
cannot pre-create it the way it could a keypair account).

Every session-authorized trading handler validates, before trusting any
policy field: exact account length, StockStream ownership, the PDA itself,
the discriminator/version, `target_program` (the executing `program_id`),
`owner`, `market`, `session_signer`, and `trader_seat_index` -- see
`session::validated_session_account`.

## Action allowlist

A single `u8` bitmap (`session::SESSION_ACTION_*`):

| Bit | Action |
| --- | --- |
| `1` | `PlaceOrder` (non-reduce-only) |
| `2` | `CancelOrder` |
| `4` | `CancelAll` |
| `8` | `ReplaceOrder` |
| `16` | `PlaceOrder` with the reduce-only flag set |

A session holding only the reduce-only bit can shrink risk but never open or
increase a position -- `PlaceOrder` requires the reduce-only bit *or* the
plain place bit depending on the order's own flag, so this is enforced per
order, not per session.

## Nonce policy

Every session-authorized instruction carries `action_nonce: u64`. Strict
monotonic, scoped to one session account:

```
instruction.action_nonce == session.next_expected_nonce
```

On complete success only:

```
session.next_expected_nonce = checked_add(session.next_expected_nonce, 1)
```

- `next_expected_nonce` always starts at `1` on `AuthorizeTradingSession`
  (there is no caller-supplied initial nonce).
- A failed action (any error, at any point in the handler) never consumes
  the nonce or mutates the session, because the nonce is only written in
  `consume_session_action`, called after the entire trading action already
  succeeded, and a Solana instruction that returns `Err` reverts every
  account write it made -- there is no manual rollback path to get wrong.
- Repeated, lower, and future/skipped nonces are all rejected
  (`StockStreamError::SessionNonceReplay`).
- The nonce is bound to one session PDA, which is itself bound to one
  `(owner, market, seat, session_signer)` tuple; a nonce value from one
  session has no meaning to another session's account (a different account
  address entirely) and a different session's own `next_expected_nonce`.
- Main-wallet actions (the seat's actual owner signs directly) do not share
  this nonce space at all and must encode `action_nonce = 0`.
- `next_expected_nonce == u64::MAX` is rejected outright (checked-add
  overflow guard); a session that reaches this must be replaced via
  `RevokeTradingSession` + `CloseTradingSession` + a fresh
  `AuthorizeTradingSession`.

## Cumulative-notional policy

`consumed_cumulative_notional` is **cumulative activity**, not outstanding
exposure:

- A risk-increasing `PlaceOrder` (or the new order half of `ReplaceOrder`)
  adds its notional: `new_consumed = checked_add(old_consumed, notional)`,
  rejected if it would exceed `max_cumulative_notional`.
- Cancelling an order (`CancelOrder`, `CancelAll`) consumes a nonce but
  **zero** notional, and does not credit back the cancelled order's
  notional into `consumed_cumulative_notional`.
- `ReplaceOrder` charges the new order's full notional, exactly like an
  independent `PlaceOrder`; the replaced order's notional is not credited
  back, for the same reason.
- A resulting-exposure cap (`max_exposure`) and a resulting-open-order-count
  cap (`max_open_orders`) are enforced separately from the notional cap,
  computed from the position/order-count the action would produce, not the
  position/count that already exists.

This means `max_cumulative_notional` bounds total trading *activity* over
the session's lifetime, not the trader's live position size at any moment --
call `UpdateTradingSessionLimits` (owner-only) to raise it, or
`RevokeTradingSession` + `CloseTradingSession` + a fresh
`AuthorizeTradingSession` to reset it to zero.

## Lifecycle

- `AuthorizeTradingSession`: main wallet only. Fails if the PDA already
  exists (whether active or merely revoked-but-not-closed) -- always a
  fresh account.
- `UpdateTradingSessionLimits`: main wallet only, never the session signer
  (a session can never expand its own authority). Fails on a revoked
  session (no "unrevoke" path). A tightened `max_cumulative_notional` may
  never drop below what the session has already legitimately consumed.
  Bumps `session_generation` (an audit/cache-invalidation counter, not a
  security boundary).
- `RevokeTradingSession`: main wallet only. Idempotent. Does not cancel any
  resting orders -- that is a separate, explicit `CancelAll`.
- `CloseTradingSession`: main wallet only, and only once revoked or expired.
  Reclaims the PDA's rent to the owner directly (no CPI needed for an
  account this program already owns).

## ReplaceOrder

Cancels the identified order and places a new one in a single instruction.
The new order always gets a fresh sequence number from the book (the same
`global_order_sequence + 1` any `PlaceOrder` would get), so a replacement
always **loses time priority** -- this program does not attempt to preserve
queue position across a price/quantity change.

There is no explicit rollback code: if placing the new order fails after the
old one was already cancelled, the whole instruction returns `Err`, and the
Solana runtime reverts every account write made during it -- the cancelled
order, its released margin reserve, and the session's nonce/notional are all
restored to exactly their pre-instruction state.

**Update:** every scoped-session event kind is now wired into the
versioned binary event ABI (`docs/events.md`): `TradingSessionAuthorized`,
`TradingSessionLimitsUpdated`, `TradingSessionActionConsumed` (emitted
after every session-consuming action across `PlaceOrder`, `ReplaceOrder`,
`CancelOrder`, `CancelAll`, always as the *last* thing that instruction
does), `TradingSessionRevoked`, `TradingSessionClosed`. `ReplaceOrder`
itself now also emits `OrderReplaced` and `CancelAll` emits
`CancelAllProgress`.
