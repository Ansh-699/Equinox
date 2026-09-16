# Program Layout

The market account is 222,752 bytes: a 512-byte header, two 90,640-byte arena
regions, 128 256-byte seats and 128 64-byte fill events. Arena nodes are 88
bytes and include branch and leaf metadata, so node capacity is not resting
order capacity. The settlement scratch PDA is derived from
`settlement || market || seat_index_le`; its padded header is 272 bytes and its
plan begins at an explicitly aligned offset.

## `MarketStateHeader::reserved_upgrade` byte map (185 bytes)

New fields are added within this fixed byte budget as they're needed, so
`MARKET_ACCOUNT_SIZE` (and every existing offset test) never changes.
Current map (see `state.rs`):

| Bytes | Field |
| --- | --- |
| `0` | collateral decimals |
| `1` | vault-initialized flag |
| `2` | `DelegationStatus` (MagicBlock lifecycle) |
| `3..11` | expected commit sequence |
| `11..19` | last committed sequence |
| `32..64` | instrument ID |
| `64..68` | Pyth Pro feed ID |
| `68` | oracle channel |
| `69..101` | delegation validator |
| `101..109` | delegation sequence |
| `109..113` | commit interval (ms) |
| `113..121` | expected final commit sequence |
| `121` | pending-undelegation flag |
| `122..130` | protocol fee balance (`u64`) |
| `130..138` | insurance fund balance (`u64`) |
| `138..146` | recognized bad debt (`u64`) |
| `146` | reconciliation status (`ReconciliationStatus`) |
| `147..155` | vault surplus (`u64`) |
| `155..185` | free (30 bytes) |

`byte [2]` (`DelegationStatus`) and the custody-gate check in
`validate_custody_tokens` used to be checked independently against
different conventions (a stale 3-value marker vs. the current 4-state
enum); see `docs/custody.md` for the integration defect that caused and the
fix (`l1_withdrawals_allowed()` is now the single source of truth).
