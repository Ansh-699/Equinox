# SBPF Compatibility

## Gate 1 Evidence

The verified Gate 1 artifact is preserved by `stockstream-mvp-gate-1`:

- SHA-256: `7bfad1e46257677bdc7ee7ec8fe0dfbab581df6eda2b968328a8c639f12e5377`
- Size: `121,952` bytes

Later runtime experiments are not Gate 1 evidence.

## Observed Toolchain

| Component | Version |
| --- | --- |
| Rust compiler | `rustc 1.98.0 (88d9e12ae 2026-08-18)` |
| Solana CLI | `4.2.1` |
| cargo-build-sbf | `4.1.0` |
| platform-tools | `v1.54` |
| LiteSVM | `0.16.0` |
| solana-sbpf in LiteSVM | `0.21.1` |
| validator | `solana-test-validator 4.2.1` |

## Failure

The default artifact reports `EM_SBPF` (`0x107`) and GNU/Linux ELF OSABI. The
Agave SBPF parser rejects that file as `Incompatible ELF: wrong ABI`.

Building with `--arch v3` produces Linux BPF with CPU version 4. LiteSVM and
`solana-test-validator` then reject it with:

`Detected sbpf_version required by the executable which are not enabled`

The installed runtime enables SBPF through v3, while platform-tools v1.54
produces an SBPF-v4 executable. A v1.51 platform-tools download was attempted
through the official `cargo build-sbf --tools-version v1.51` path, but the
download stalled before completing. No ELF bytes were patched and no native
mock was used.

## Status

- Gate 1: PASS
- Gate 2 harness implementation: COMPLETE
- Gate 2 runtime execution: BLOCKED - TOOLCHAIN
- Runtime/developer network execution: BLOCKED until a matching Agave and
  platform-tools pair is installed.

The runtime test is `runtime_initialize.rs`, feature-gated with
`runtime-tests`, and loads `target/deploy/stockstream.so` directly.
