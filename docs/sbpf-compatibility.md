# SBPF compatibility

**Status: RESOLVED (2026-09-17).** The source-built SBF artifact loads and
executes in a real SVM. Gate 2 is **partially verified**: the settlement path
runs (initialize, trader seats, scratch lifecycle, two-trader crossing fill,
self-trade prevention, `ReplaceOrder` runtime rollback). MagicBlock and Pyth
external-program CPIs remain runtime-unverified.

## The authoritative toolchain

`scripts/install-equinox-toolchain.sh` installs one Agave release and checks
every tool against its own expected version
(`toolchain/equinox-runtime.env`):

| Tool | Version |
| --- | --- |
| solana-cli | 4.2.1 |
| cargo-build-sbf | 4.1.0 |
| platform-tools | v1.54 |
| rustc (platform-tools) | 1.89.0 |
| LiteSVM (harness) | 0.16.0 |

The artifact is reproducible byte-for-byte from a clean worktree:
`target/deploy/equinox.so`, 261,312 bytes, SHA-256
`70594f80a521e34788eb082e9c6b27b842c4830ece5faff76df9a21c257c3ca1`.

## What the blocker actually was

It was **not** an SBPF instruction-version mismatch, and **not** the linker. It
was a single ELF field. `solana-sbpf` (used by both LiteSVM 0.16 and
`solana program deploy`) rejects any artifact whose `EI_OSABI` is not
`ELFOSABI_NONE`:

```rust
if header.e_ident.ei_osabi != ELFOSABI_NONE {
    return Err(ElfError::WrongAbi);
}
```

Production carried one `#[used]` static -- a Phase 2 retention anchor for the
arena/matcher code, obsolete once `handlers::place_order_core` called
`Arena::validate` directly. LLVM emits `SHF_GNU_RETAIN` for `#[used]` statics,
and lld then tags the whole ELF `ELFOSABI_GNU`. Removing the static made
`EI_OSABI` naturally `0` and the artifact load (commit `1635d6a`).

This was established by bisection with a minimal Pinocchio control program, not
by inspection: pinocchio-only produced `EI_OSABI=0`; adding a single
`#[used]` static produced `EI_OSABI=3` with `SHF_GNU_RETAIN` on `.rodata`.

Two earlier theories -- std linkage pulled in by the MagicBlock API crates, and
the `solana-address` crate -- were **disproven**. The MagicBlock API crates were
still moved to dev-dependencies (commit `bf866f2`) because production used only
their constants, but that change alone did not affect the header.

## The version-pin trap

The previously pinned Agave `2.2.20` could not build this workspace at all: its
bundled cargo 1.84 cannot parse `edition2024` dependencies (`block-buffer`,
`constant_time_eq` via `blake3`). Having two contradictory "authoritative"
versions -- a `2.2.20` environment pin against a `Cargo.toml` targeting Agave
4.2 -- is what obscured the real blocker. There is now exactly one pin, in
`toolchain/equinox-runtime.env`.

## Enforcement

`scripts/verify-sbf-artifact.py` runs in CI and rejects: `EI_OSABI != 0`, a zero
entry point, a stub-sized artifact (the ~1.3 KB no-`bpf-entrypoint` case), a
wrong `e_machine`, or a missing program ID. It also reports `SHF_GNU_RETAIN`, so
a future `#[used]` is visible rather than silent.

**Production hardening and audit remain pending. Production not approved.**
