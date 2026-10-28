# Program size: how small can Equinox get

Researched and measured 2026-10-28. All builds in a scratch copy; the repo is unchanged.

## Answer

Deleting instructions plus every safe compiler setting bottoms out at **254 KB** (1.29 SOL at today's rent). Getting under 98 KB, which is 0.5 SOL at today's rate, needs a rewrite of how the code touches account data. Compiler flags cannot get there. SIMD-0437 rent cuts do most of the work anyway: 254 KB costs 0.34 SOL at step 4 and 0.18 SOL at step 5.

## Brief

- **Question:** what is the smallest the mainnet program can be, and how do we get there?
- **Decision it informs:** delete code, change build settings, or rewrite.
- **Constraint:** keep overflow checks and the compute budget.
- **Target:** under 0.5 SOL of program rent.

## Measured ladder

| Step | Size | SOL now (5,080) | Step 4 (1,322) | Step 5 (696) |
|---|---|---|---|---|
| Today's build | 582,848 | 2.96 | 0.77 | 0.41 |
| Old pre-v3 code deleted | 378,096 | 1.92 | 0.50 | 0.26 |
| Trading only (replace, cancel all, pre-IPO reporter, second deposit path and admin setters also stubbed) | 313,976 | 1.60 | 0.42 | 0.22 |
| Trading only + all safe settings, opt 3 | 277,760 | 1.41 | 0.37 | 0.19 |
| Trading only + all safe settings, opt "s" | 254,312 | 1.29 | 0.34 | 0.18 |

Each setting measured alone, against the 313,976-byte trading-only build:

| Setting | Size | Change | Notes |
|---|---|---|---|
| `--arch v3` | 301,776 | −3.9% | Active on mainnet since epoch 993; MagicBlock validator v1.0 lists sBPF v3 support [S3] |
| `--arch v2` | 304,936 | −2.9% | Active on mainnet |
| `--arch v1` | 314,280 | 0 | |
| `-Zlocation-detail=none -Zfmt-debug=none` | 305,824 | −2.6% | Needs `RUSTC_BOOTSTRAP=1`; drops panic file and line info |
| `-C llvm-args=-inline-threshold=25` | 298,248 | −5.0% | Compute cost not measured |
| `opt-level = "s"` | 280,064 | −10.8% | +30–70% compute on session instructions |
| `opt-level = "z"` | larger than "s" | | InitializeMarket ran out of compute (200k) |
| `overflow-checks = false` | 304,864 | −2.9% | Not acceptable: safety net |
| `--icf=all` (linker) | 313,976 | 0 | |

## Why it stays big

Disassembly of the trading-only build: 35,786 instructions, 8 bytes each.

- **Data movement:** 62% of instructions just move data.
  - 7,504 are register moves.
  - 8,803 are stack saves and reloads, which is 60% of all loads and stores.
  - sBPF has 10 registers. A 32-byte address fills 4 and an i128 fills 2, so big handlers keep spilling to the stack.
- **Small factors:** unrolled copies (11 KB), overflow checks (9 KB), logging (5 KB) and strings (2 KB) are small.
- **Biggest functions:**

| Function | Size |
|---|---|
| place order with matching | 17 KB |
| session authorize | 9 KB |
| undelegate callback | 8.5 KB |
| liquidate | 7.6 KB |
| apply fill | 7.4 KB |

## What a rewrite would change, by expected payoff

1. **Stop copying state.** Work through `&mut` references into account data instead of reading records out with byte offsets and writing them back. This targets the 45% of code that is moves and spills.
2. **Use u64/i64 math where the range allows.** Prices, quantities and collateral fit in 64 bits, and products can use checked widening only at the multiply. Every i128 value costs two registers, and u128 division alone is 5 KB of compiler builtin.
3. **Validate the account bundle once.** Use one non-inlined function and pass an index struct, not 27 addresses.
4. **Turn setters into constants.** Keeper, reporter and risk parameters become constants changed by upgrade, which removes whole instructions.
5. **Shrink the account bundle.** Fewer book pages (18 today) means less validation code, less rent per market and fewer commit fees.
6. **Hand-written sBPF assembly is the extreme end.** Blueshift's `sbpf` toolchain exists, and Dean Little reported 76 KB → under 1 KB for a small program [S2, low: secondhand talk summary]. It is not realistic for a perp engine that also needs an audit.

Pinocchio itself is already the lean SDK [S1]. The remaining weight is our code's structure, not dependencies: deps are under 10 KB of the build.

## Open questions

- **How much does pattern 1–3 save per handler?** Experiment: rewrite `place_order_v3` in scratch and measure size and compute. One handler predicts the rest.
- **Does the MagicBlock devnet ER execute `--arch v3` programs?** Deploy an sBPF v3 build to a devnet test program ID and run the live E2E suite.
- **Compute cost of opt "s" and the inline threshold on the v3 hot path.** No LiteSVM test drives `place_order_v3`; it needs a bench.
- **SIMD-0437 steps 3–5 timing.** Planned for Agave 4.4, November 2026, unconfirmed.

## Sources

- [S1] Solana Compass, Accelerate 2025, "No-strings-attached programs w/ Pinocchio" (secondary, 2025): https://solanacompass.com/learn/accelerate-25/scale-or-die-2025-no-strings-attached-programs-w-pinocchio
- [S2] Solana Compass, Accelerate 2025, "Writing Optimized Solana Programs" (secondary, 2025): https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-writing-optimized-solana-programs
- [S3] Solana Compass, MagicBlock Validator v1.0 release (secondary, 2026-10): https://solanacompass.com/news/magicblock-releases-validator-v10-for-ephemeral-rollups-on-solana-with-new-session-and-commit-fees
- [S4] Helius, sBPF assembly guide (primary tutorial): https://www.helius.dev/blog/sbpf-assembly
- [S5] Solana Foundation, reduced rent (SIMD-0437) (primary): https://solana.com/upgrades/reduced-rent
- **Mainnet feature status:** `solana feature status --url mainnet-beta`, read 2026-10-28.
- **Upgrade rent refund:** `solana-bpf-loader-program` 4.2.2, `src/lib.rs` around line 537.
