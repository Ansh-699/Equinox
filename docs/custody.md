# Custody

Priority 4 completes production custody, vault accounting, withdrawal health,
fee/insurance ledgers and vault reconciliation on top of the existing (not a
parallel) custody model from Priorities 1-3. Everything below is code
implemented, unit tested, and SBF compiled. Live SPL CPI execution is
**not** runtime-verified: `invoke_with_program`/`invoke_signed_with_program`
are no-ops off the SBF target (see `docs/magicblock.md`), so host tests cover
every pre-CPI validation and post-CPI ledger update, not the actual token
movement.

## Vault model (Model A, canonical, not an ATA)

- `vault = find_program_address(["vault", market], program_id)` -- a token
  account owned by the legacy SPL Token program, authority delegated to...
- `vault_authority = find_program_address(["vault-authority", market], program_id)`
  -- a pure PDA (no account data), the vault's SPL "owner"/transfer authority.

Both are derived and validated in every custody handler
(`initialize_vault`, `deposit_collateral`, `withdraw_collateral`,
`withdraw_ledger_balance`, `reconcile_vault`); no handler accepts a
caller-supplied vault or vault-authority address that doesn't match the
derivation. Token policy is fixed at initialization: the legacy SPL Token
program only, at the mint's exact recorded decimals; Token-2022 (or any other
token-program address) is rejected by `custody_config`. The devnet USDC
reference `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals) is a
deployment fixture, never hardcoded into this generic logic.

Market/vault configuration lives in `MarketStateHeader`: `collateral_mint`,
`collateral_token_program` (existing fields), plus
`reserved_upgrade[0]` = collateral decimals and `reserved_upgrade[1]` = vault
initialized flag (existing, from Priority 1-3). Priority 4 adds, in the same
`reserved_upgrade[185]` byte budget (no `MARKET_ACCOUNT_SIZE` growth, so no
existing offset changes):

| Bytes | Field | Accessor |
| --- | --- | --- |
| `122..130` | `protocol_fee_balance: u64` | `protocol_fee_balance()` / `set_protocol_fee_balance()` |
| `130..138` | `insurance_fund_balance: u64` | `insurance_fund_balance()` / `set_insurance_fund_balance()` |
| `138..146` | `recognized_bad_debt: u64` | `recognized_bad_debt()` / `set_recognized_bad_debt()` |
| `146` | `reconciliation_status: u8` | `reconciliation_status()` / `set_reconciliation_status()` |
| `147..155` | `vault_surplus: u64` | `vault_surplus()` / `set_vault_surplus()` |

Bytes `155..185` (30 bytes) remain free.

## Collateral accounting

This program uses an **immediate-settlement model**, not deferred
accrual: `risk::apply_fill` deducts trading fees straight into
`TraderSeat::realized_pnl` at fill time, and `risk::settle_funding` deducts
funding the same way. There are no separate "pending fee" / "accrued
funding" per-seat fields, and Priority 4 deliberately does not add a
parallel model for them -- doing so would duplicate accounting the existing
`realized_pnl` field already performs.

Per-seat fixed-point (all integer, all checked arithmetic):

- `available_collateral: i128` -- actual deposited-minus-withdrawn tokens.
  The *only* field withdrawals or deposits ever move; never goes negative
  (`prepare_withdrawal` rejects any withdrawal that would).
- `realized_pnl: i128` -- trading PnL, funding, and fees already netted in.
- `unrealized_pnl` -- computed on demand from `base_position`/`quote_entry_value`
  against the last verified oracle price (`risk::unrealized_pnl`).
- `reserved_margin: i128` -- worst-case margin reserved by resting orders.

`equity = available_collateral + realized_pnl + unrealized_pnl`
(`risk::equity`, unchanged from Priorities 1-3).

A consequence of this model, not a bug: a trader's actual *token* claim
against the vault is always `available_collateral`, never `equity`. Realized
trading profit is not automatically converted into withdrawable collateral;
this is documented, not fixed, since changing it would be an economic-model
change beyond completing custody accounting. It also means
`total_trader_collateral` (the sum of every seat's `available_collateral`,
used for reconciliation) is always the exact real-token liability the vault
owes traders: it can never be inflated or deflated by unsettled PnL.

### Withdrawal health

`risk::prepare_withdrawal` (extended, not replaced, in Priority 4):

```
post_withdraw_equity = equity - withdrawal_amount
require: post_withdraw_equity >= maintenance_margin(|position|) + reserved_margin + withdrawal_buffer
require: post_withdraw_available_collateral >= 0
```

`withdrawal_buffer` is the new parameter (`risk::DEFAULT_WITHDRAWAL_BUFFER =
0`, documented placeholder -- no governance instruction currently sets a
non-zero per-market buffer; adding one later only means passing a
header-stored value into this same formula). `reserved_margin` already
reflects worst-case resting-order exposure, so it is not double-counted.
Rounding: `fee()`/margin computations floor toward zero (integer division,
existing behavior); a withdrawal amount is never rounded up in the trader's
favor.

`withdraw_collateral` additionally requires, gate by gate:

1. **Main-wallet signer only.** There is no scoped-trading-session account
   in `WithdrawCollateral`'s account list at all, so a session signer
   structurally cannot reach this instruction -- not merely rejected by a
   runtime check.
2. `header.l1_withdrawals_allowed()` (delegation status `NotDelegated` or
   `Restored`; blocked for `Delegated`/`Undelegating`).
3. `!header.withdrawals_blocked_by_reconciliation()` (new: blocked for
   `DeficitDetected`/`RecoveryRequired` -- see Reconciliation below).
4. A fresh, valid oracle (`header.oracle_valid == 1`) **unconditionally**,
   not only when the seat currently holds a position: a flat seat can open
   a position immediately after withdrawing, so gating freshness on the
   seat's *current* position would let it withdraw against a stale price
   and re-lever a moment later.
5. `risk::prepare_withdrawal`'s full margin/health check (above).
6. Destination account mint/owner match the configured mint and the
   withdrawing trader.
7. Canonical vault + vault-authority PDA validation
   (`derive_vault`/`derive_vault_authority`), enforced identically to
   deposit.

No caller-provided price ever influences any of this -- only
`header.last_verified_oracle_price`, set exclusively by
`consume_oracle_update` (see `docs/oracle.md`).

### Deposit/withdraw CPI ordering

Both `deposit_collateral` and `withdraw_collateral` credit/debit the
in-memory ledger (`seat.available_collateral`) **before** issuing the SPL
Transfer CPI, then persist that mutated seat with `write_seat` **after** the
CPI returns `Ok`. This relies on Solana's own atomic instruction rollback:
every fallible check (signer, delegation/reconciliation state, custody
config, mint/vault/token-program identity, source balance or margin health)
has already completed by the time the in-memory mutation happens, so the
only way execution reaches the CPI is with a transfer already known to be
valid. If the CPI itself still fails, `?` propagates the error out of
`dispatch` and the runtime discards every write this instruction made,
including the seat mutation -- so the ledger is never actually observed
changed unless the transfer also succeeded. No fallible arithmetic runs
after the CPI.

### A real integration defect found and fixed this priority

`validate_custody_tokens` (both deposit and withdraw call it) used to
independently check `header.reserved_upgrade[2] != 0` to gate custody
movement -- literally the same byte `DelegationStatus` (introduced in
Priority 1) is stored at. Under the current 4-state model
(`NotDelegated=0, Delegated=1, Undelegating=2, Restored=3`), a `Restored`
market (status `3`) would pass `withdraw_collateral`'s own
`l1_withdrawals_allowed()` check (which permits `0` and `3`) but then fail
this second, stale check (which only permitted exactly `0`) -- making
withdrawal impossible in a state where it should be allowed. Fixed by
replacing the duplicated raw-byte check with `!header.l1_withdrawals_allowed()`,
the single source of truth. `tests/custody.rs::withdraw_is_blocked_while_delegated_and_allowed_once_restored`
is the regression test.

### A second, more serious defect found and fixed this priority

`deposit_collateral` and `withdraw_collateral` each decoded the source (or
destination) SPL token account into a `Ref<Account>` bound with `let`
(un-scoped), then issued the SPL `Transfer` CPI against that same account
while the `Ref` was still alive. `pinocchio_token`'s own CPI account writer
(`write_accounts`) explicitly checks `is_borrowed()` on every account it
touches and rejects the call with `ProgramError::AccountBorrowFailed` if
so -- and this check runs unconditionally, not only on a real SBF target.
This means **every deposit and withdrawal would have failed on-chain**,
not just in tests -- it was undetected only because no test previously
exercised either handler's CPI path end to end. Fixed by scoping each
decode-and-validate block so the `Ref` drops before the CPI executes.
Covered by every deposit/withdrawal test in `tests/custody.rs` (all of
which exercise the full instruction, including the CPI construction path).

## Fees and insurance

Three market-level ledger balances, kept separate from trader collateral:
`protocol_fee_balance`, `insurance_fund_balance`, `recognized_bad_debt`.

**Fee crediting is automatic, not a separate collection step.** Because
`apply_fill`/liquidation fees are already deducted from a seat's
`realized_pnl` at the moment they're charged (the existing immediate-
settlement model), Priority 4 credits that exact same amount to
`protocol_fee_balance` in the same instruction, atomically:

- `place_order_core` (covers `PlaceOrder` and `ReplaceOrder`): the total
  maker+taker fee across every fill in the instruction is accumulated in
  `plan_seat_results` and credited to the header before `write_header`.
- `liquidate`: the liquidation fee from `apply_fill` is credited the same
  way.

There is intentionally no `CollectProtocolFees` instruction: nothing would
be left for it to collect, since crediting already happens at fill time.
This closes a real accounting gap -- previously, fees were deducted from
traders and never credited anywhere, so the vault's expected liability
never reflected them.

New instructions (opcodes 34-39), none reachable via any scoped
trading-session account (they simply don't accept one, so a session signer
can never invoke them, independent of any action allowlist):

| Instruction | Opcode | Accounts | Authority |
| --- | --- | --- | --- |
| `TransferToInsuranceFund` | 34 | `[market, authority]` | `market_authority` |
| `WithdrawProtocolFees` | 35 | `[market, authority, vault, vault_authority, destination, mint, token_program]` | `market_authority` |
| `WithdrawInsuranceFunds` | 36 | same as above | `emergency_authority` |
| `RecordBadDebt` | 37 | `[market, authority]` | `emergency_authority` |
| `ResolveBadDebt` | 38 | `[market, authority]` | `emergency_authority` |
| `ReconcileVault` | 39 | `[market, vault, mint, token_program]` | permissionless |

- `TransferToInsuranceFund` is a pure internal ledger reassignment (both
  balances are backed by the same vault): no token CPI.
- `WithdrawProtocolFees`/`WithdrawInsuranceFunds` share one implementation
  (`withdraw_ledger_balance`) and perform a real vault-authority-signed SPL
  transfer to `destination`, which must use the market's configured mint
  and token program -- there is no path to redirect either ledger to an
  unapproved asset. Traders can never reach either handler (no seat/session
  concept in their account list at all).
- `RecordBadDebt(seat_index, amount)` requires the target seat's equity to
  actually be negative (bankrupt) and `amount <= -equity`; it forgives that
  much of the seat's negative `realized_pnl` (pulling its health toward
  zero) and increases `recognized_bad_debt` by the same amount. It never
  touches `available_collateral` -- in this token model that field can
  never go negative, so bad debt can only ever be a `realized_pnl`
  write-off, not a vault shortfall by itself.
- `ResolveBadDebt(amount)` pays recognized bad debt down from the insurance
  fund: both `recognized_bad_debt >= amount` and
  `insurance_fund_balance >= amount` are required, and both decrease by
  `amount`.

Invariant (see Reconciliation): `expected_vault_liability =
total_trader_collateral + protocol_fee_balance + insurance_fund_balance -
recognized_bad_debt`. Subtracting `recognized_bad_debt` reflects that a
formally-written-off shortfall is no longer expected to be backed by the
vault -- it is a governance acknowledgement, not a real reduction in
`available_collateral` (which recorded bad debt never touches).

## Reconciliation

`ReconcileVault` is permissionless (any keeper may call it): it only ever
*recomputes and records* a status, never moves tokens or seat balances, so
there is nothing for an unprivileged caller to abuse. It:

1. Validates the vault/mint/token-program against the canonical derivation
   and `custody_config`, exactly like every other custody handler.
2. Decodes the vault's actual SPL token balance.
3. Sums every seat's `available_collateral` (`total_trader_collateral`,
   bounded to exactly `MAX_TRADER_SEATS` = 128 reads -- computed on demand
   rather than tracked as a running total, to avoid synchronization drift).
4. Computes `expected_vault_liability` (above) and compares.

`MarketStateHeader::reconciliation_status()` (`ReconciliationStatus` in
`state.rs`):

- **`Reconciled`** (0, default): actual balance matches exactly.
- **`SurplusDetected`** (1): actual balance exceeds expected.
  `vault_surplus` records the amount; it is **never** auto-assigned to any
  trader -- recorded for a documented governance recovery process only.
- **`DeficitDetected`** (2): actual balance is short. The market is
  immediately set to `MarketMode::Paused` (stopping new risk via the
  existing `header.mode != Open` check in `place_order_core`), and
  `withdraw_collateral` rejects every withdrawal
  (`withdrawals_blocked_by_reconciliation()`) until this clears.
- **`RecoveryRequired`** (3): a deficit persisted across two consecutive
  reconciliations (i.e. `ReconcileVault` was already at `DeficitDetected`
  or `RecoveryRequired` and is still short). Requires explicit governed
  recovery (deposit, `RecordBadDebt`/`ResolveBadDebt`, or a market
  authority action) before a further `ReconcileVault` call can clear it.

Reconciliation does not touch delegation state; it operates purely on the
L1 market account and vault, independent of the MagicBlock delegation
lifecycle (see `docs/magicblock.md`).

## Account aliasing

`validate_custody_aliases` (deposit/withdraw, all 7 accounts pairwise
distinct) and equivalent inline pairwise checks in `withdraw_ledger_balance`
(7 accounts) and `reconcile_vault` (4 accounts) reject any duplicate
address among an instruction's own accounts. All token accounts are
validated through the real decoded SPL layout
(`pinocchio_token::state::{Mint, Account}`): initialization, mint/owner
match, and (for the vault) ownership by the derived vault-authority PDA.
`custody_config` additionally rejects any token program other than the
canonical legacy SPL Token program, and any mint/token-program pair that
doesn't match the market's own recorded configuration.

## Events

Custody events are emitted as Solana program logs via `pinocchio_log`
(`Logger::<256>`, a real, already-official `anza-xyz/pinocchio` crate,
Apache-2.0) rather than a new on-chain ring buffer -- adding binary storage
would have required growing `MARKET_ACCOUNT_SIZE`, cascading into every
existing offset and test in this program for no benefit an indexer cannot
already get from transaction logs. `sol_log_` is the real syscall on-chain;
off the SBF target the same crate falls back to `println!`, so these are
directly observable in host tests (see the `SS:...` lines each
`tests/custody.rs` test prints).

Format: `SS:<Kind> market=<hex32> [seat=<u16>] amount=<u64> seq=<u64>
balance=<u64> mint=<hex32>`. `seq` is `header.global_event_sequence`, the
same monotonic counter fill events already use (advanced by whichever
custody handler emits the event); "market"/"mint" are 64-character
lowercase hex, not base58, to avoid pulling in a base58 dependency for a
32-byte value already fully recoverable from the transaction's own account
list. Ten kinds: `VaultInitialized`, `CollateralDeposited`,
`CollateralWithdrawn`, `ProtocolFeeCollected`, `InsuranceFundChanged`,
`BadDebtRecorded`, `BadDebtResolved`, `VaultSurplusDetected`,
`VaultDeficitDetected`, `ReconciliationRestored`.

`clients/equinox/src/index.ts` decodes these with `decodeCustodyEvent`
(a regex over `meta.logMessages`, not an Anchor-style CPI event), and
provides typed builders for every new instruction
(`transferToInsuranceFund`, `withdrawProtocolFees`, `withdrawInsuranceFunds`,
`recordBadDebt`, `resolveBadDebt`, `reconcileVault`), plus `decodeInstruction`
entries for opcodes 34-39. Golden vectors for account order and instruction
data live in `clients/equinox/src/index.test.ts`.

## Testing

`programs/equinox/tests/custody.rs` (10 tests) and
`programs/equinox/tests/account_settlement.rs::crossing_fill_credits_the_protocol_fee_ledger`
(1 test) cover: vault initialization (config storage, duplicate-init
rejection, wrong-authority rejection with every other account otherwise
valid), deposit (credit, non-owner rejection, insufficient-balance
rejection, prohibited-alias rejection), withdrawal (success within health,
margin-violation rejection, the `Delegated`/`Restored` regression above,
the reconciliation-deficit gate), fee crediting from a real crossing fill,
fee/insurance ledger transfer and withdrawal (including authority
rejection), bad-debt recording and resolution (including the
insufficient-coverage rejection), and the full reconciliation state
machine (`Reconciled` -> `SurplusDetected` -> `DeficitDetected` ->
`RecoveryRequired`, including the automatic pause).

As with Priorities 1-3, `invoke_with_program`/`invoke_signed_with_program`
being no-ops off the SBF target means these are wire-conformance plus
full pre-CPI-validation tests, not proof that a real token transfer
executes correctly on a live cluster.

**Update:** all 10 custody events now use the versioned binary event ABI
(`docs/events.md`), migrated off the earlier Priority-4 text-based
`SS:<Kind> ...` log format, which the program no longer emits at all.
Withdrawal-blocked coverage was extended to the `Undelegating` status
(previously only `Delegated`/`Restored` were tested) -- see
`docs/security.md`. **Audit pending. Production not approved.**
