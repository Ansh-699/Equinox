# Testing

Rust debug and release suites cover account layouts, order book, settlement,
registry, scratch, risk and instruction vectors. TypeScript covers SDK,
authentication, execution boundaries, markets, oracle keeper and indexer
primitives. Runtime tests load the SBF artifact only when the selected Agave,
SBPF and harness versions are compatible; native mocks are not runtime evidence.

**Update:** 155 Rust tests (up from 132), 46 root TypeScript tests, 155
Worker tests (up from 66) as of this session, covering the complete
binary event ABI (`docs/events.md`), transaction transports and keeper
signer (`docs/transports.md`), all six keeper jobs, ER/L1 reconciliation,
private trader projections, and a dedicated adversarial/failure-path
pass across 21 scenarios (cross-market substitution, wrong PDA, account
aliasing, wrong signer/oracle, session replay/limit-bypass, commit
replay, forged callback, delegation-gated withdrawal, event-sequence
overflow, fill/event collision, keeper split-brain, stale fencing,
duplicate transaction, indexer sequence gap, failed resnapshot, private-
projection leakage, signer secret leakage, transport timeout/retry --
not an independent audit). The SBF artifact was rebuilt in a clean,
disposable `git worktree` with a fresh `npm ci` (no `--legacy-peer-deps`)
and produces a byte-identical, reproducible hash both there and in the
working tree: `63a4274f2ac1c95afa53299b986c8eb02cc206d64af7706a4e411c3caa8b1ec6`,
253,424 bytes. Note the correct build invocation requires
`--features bpf-entrypoint`; without it, `cargo build-sbf` silently
compiles a ~1.3KB stub with no registered program entrypoint.
