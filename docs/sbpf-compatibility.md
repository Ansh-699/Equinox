# SBPF compatibility

The local Gate 2 execution path remains blocked because the installed tools are
mixed: the current `cargo-build-sbf` emits SBPF v4 while the available runtime
accepts through SBPF v3. No ELF patching or native execution substitute is used.

The reproducible path is `scripts/install-stockstream-toolchain.sh`, which pins
the official Anza Agave `2.2.20` release. That release is intended to provide
the matching `solana`, `cargo-build-sbf`, `solana-test-validator` and
platform-tools set together. The script refuses a mixed version set, rebuilds
the real SBF artifact, and then runs the serialized runtime harness in CI.

The runtime workflow is `.github/workflows/stockstream-runtime.yml`. It is not
claimed as executed locally in this environment. Current local evidence is:

- Gate 1: PASS, artifact `target/deploy/stockstream.so` at tag `stockstream-mvp-gate-1`.
- Gate 2 harness implementation: COMPLETE.
- Gate 2 runtime execution: BLOCKED — TOOLCHAIN.
- No compatible runtime execution or compute-unit measurement is claimed.
