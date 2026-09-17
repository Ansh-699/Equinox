#!/usr/bin/env python3
"""Complete MagicBlock economics for the StockStream delegated hot cluster,
from the ACTUAL implementation (`magicblock.rs`) and the delegation program's
own pinned constants (dlp_api 3.1.0: COMMIT_FEE_LAMPORTS=100_000,
SESSION_FEE_LAMPORTS=300_000) plus the documented live-fee behavior
(docs.magicblock.gg fees-and-commit-economics, verified 2026-09-17)."""

MARKET_BYTES = 222_752
SCRATCH_BYTES = 12_288          # SETTLEMENT_SCRATCH_LEN (12 KiB cap)
SESSION_BYTES = 256
COMMIT_INTERVAL_MS = 30_000     # program constant (COMMIT_INTERVAL_MS)
COMMIT_FEE = 100_000            # lamports/account/bundle, live from commit 26
SESSION_FEE = 300_000           # lamports, deposit charge per session
FREE_COMMITS = 25               # commits 1-25 free (fee-payer path)


def rent(size: int) -> int:
    return (size + 128) * 6_960


def deposit_accounts() -> int:
    return rent(100) + rent(120)  # delegation record + metadata


def economics(traders: int) -> dict:
    members = 1 + traders * 2  # market + scratch + session per trader
    commits_per_day = 86_400_000 // COMMIT_INTERVAL_MS
    live_fee_day = members * COMMIT_FEE * max(0, commits_per_day - FREE_COMMITS)
    one_time_deposit = members * deposit_accounts()
    return {
        "members": members,
        "commits_per_day": commits_per_day,
        "one_time_deposit_sol": one_time_deposit / 1e9,
        "live_fees_sol_per_day": live_fee / 1e9,
        "live_24h_sol": live_fee / 1e9,
        "live_7d_sol": live_fee * 7 / 1e9,
    }


def live_fee(members: int) -> int:
    return members * COMMIT_FEE * max(0, 86_400_000 // COMMIT_INTERVAL_MS - FREE_COMMITS)


def main() -> None:
    market_rent = rent(MARKET_BYTES) / 1e9
    scratch_rent = rent(SCRATCH_BYTES) / 1e9
    session_rent = rent(SESSION_BYTES) / 1e9
    print("=== Cluster shape (actual implementation) ===")
    print(f"market: {MARKET_BYTES:,} B, rent {market_rent:.6f} SOL")
    print(f"scratch per active trader: {SCRATCH_BYTES:,} B, rent {scratch_rent:.6f} SOL")
    print(f"session per active trader: {SESSION_BYTES} B, rent {session_rent:.6f} SOL")
    print(f"deposit (record+metadata) per delegated account: {deposit_accounts()/1e9:.6f} SOL")
    print(f"fee-free commits per account: {FREE_COMMITS}; live fee {COMMIT_FEE} lamports/account/commit; session charge {SESSION_FEE} lamports")

    for traders in (1, 2, 10, 50, 128):
        members = 1 + traders * 2
        day = live_fee(members)
        # Deposit-charge ceiling at undelegation: min(held deposit, session + (commits-1)*COMMIT_FEE)
        ceiling = SESSION_FEE + (86_400_000 // COMMIT_INTERVAL_MS - 1) * COMMIT_FEE
        print(f"\n=== {traders} trader(s): {members} delegated accounts ===")
        print(f"  auto-commits/day/account at 30s: {86_400_000 // COMMIT_INTERVAL_MS:,}")
        print(f"  one-time refundable deposit rent: {members * deposit_accounts()/1e9:.4f} SOL")
        print(f"  live commit fees (full day, no top-up cap): {day/1e9:.4f} SOL/day")
        print(f"  24h live runway:  {day/1e9:.4f} SOL")
        print(f"  7d live runway:   {day*7/1e9:.4f} SOL")
        print(f"  undelegation deposit-charge ceiling per account: {min(deposit_accounts(), SESSION_FEE + (86_400_000 // COMMIT_INTERVAL_MS - 1) * COMMIT_FEE)/1e9:.6f} SOL")
        print(f"  note: without a delegated fee payer, commits 1-10 are free and commit 11+ is rejected; with one, commits 1-25 are free.")


if __name__ == "__main__":
    main()
