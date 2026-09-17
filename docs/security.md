# Security

Primary controls are PDA and owner validation, account alias rejection, checked
arithmetic, bounded loops, stale-plan snapshots, scoped session authorization,
oracle signature ordering, custody mint validation and sequence reconciliation.
Open findings: compatible SBPF runtime, live Pyth/Privy/MagicBlock execution,
formal audit, and full long-duration/fuzz coverage. Audit pending; production
not approved.

## Worker-side controls (Priority 5/6, 2026-09-17)

- **Private trader data isolation**: a private WebSocket channel is only
  opened after the presented token is verified (D1-backed, SHA-256-hashed,
  scoped to one `(wallet, marketPda, seatIndex)` triple, market-bound so a
  token issued for one market is rejected against any other); issuance
  itself independently confirms on-chain seat ownership rather than
  trusting the caller's assertion. An invalid/expired/revoked token gets
  the connection rejected outright (401), never silently downgraded to a
  public-only connection. The public broadcast path and the private
  delivery path are structurally separate methods on `MarketStream`, so a
  private field can never reach a public socket by construction, not by a
  filter that could be forgotten on a new event type. See `docs/worker.md`.
- **Ingestion authenticity**: only custody events decoded from a
  transaction the cluster did not mark failed are ever turned into
  `MarketEvent`s (`event-decoder.ts`); a failed transaction's logs
  describe rolled-back state.
- **Keeper isolation**: every scheduled keeper (cleanup, ingestion) runs
  under its own D1-fenced lease with a monotonic fence number, so a keeper
  instance that has lost its lease to another cannot write a stale result
  afterward (`repositories.ts::ProtocolRepository`, pre-existing).
- **ER state is never displayed as L1-committed truth**: `execution-status.ts`
  is a purely additive indexer-side display model; it does not and cannot
  weaken the actual on-chain enforcement of withdrawal safety, which
  remains `DelegationStatus`/`l1_withdrawals_allowed()` in the Rust
  program.

Still open for the Worker specifically: no Privy JWT verification happens
in the Worker itself (delegated to the Next.js app's existing session
store, `lib/auth/session.ts`, over a service-to-service channel not yet
built).

**Update:** a real keeper signer/wallet-management surface now exists
(`workers/src/signer.ts`) and has been reviewed as part of this session's
own security/failure-path pass (not an independent audit): private-key
material is never exported or logged, every configuration-error message
is redacted, the production signer's actual signing key is
non-extractable, and a keeper signer structurally cannot be the program's
upgrade authority, a user's withdrawal authority, or a Privy embedded
wallet (none of those are `Signer` implementations anywhere in the
module). This session also closed four real coverage gaps found by a
dedicated audit of 21 adversarial scenarios: cross-market account
substitution, withdrawal-blocked-while-`Undelegating`, event-sequence
overflow at `u64::MAX`, and a genuine robustness bug in
`runIngestionTick` where one market's failed resnapshot silently aborted
processing for every other market in the same tick (fixed). See the
`complete core security and failure-path testing` commit. **Audit
pending. Production not approved.**
