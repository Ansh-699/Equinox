# Transaction transports and keeper signer infrastructure

Status: **code complete and Workers-runtime tested against a real mock JSON-RPC HTTP handler; not live-network verified** (no live Solana L1 or MagicBlock ER endpoint was reached this session).

## Signer infrastructure (`workers/src/signer.ts`)

`Signer` is the only interface any keeper job or transaction transport may depend on for authorizing a transaction: `keyId` (opaque, log-safe), `publicKey()`, `sign(message)`, `health()`. No method anywhere returns private-key bytes.

Adapters:
- **`DeterministicTestSigner`** -- Ed25519 keypair derived from `SHA-256("stockstream-test-signer:" + keyId)`. Reproducible across runs, real (independently verifiable) signatures, never for production.
- **`LocalKeypairSigner`** -- loads a raw 32-byte seed or a Solana-CLI-style 64-byte JSON keypair array from a string (meant to come from a gitignored local file or a Worker secret binding). Local dev only.
- **`MockSigner`** -- fixed pubkey, fixed fake signature, no real cryptography; for keeper-control-flow tests (retries, dead-letters, lease fencing) that don't care about signature validity.
- **`SecretBackedSigner`** (the real production adapter) -- imports an Ed25519 key from a `ProductionSignerSecret` (a Worker secret's private-key material, as JWK-JSON or base64 seed/PKCS8, plus an `expectedPublicKey` to validate against). The actual signing `CryptoKey` is imported **non-extractable**; a second, momentarily-extractable import is used exactly once, at construction, only to derive the public key for that validation, and is never retained. Every configuration-error message is fixed and redacted -- none include the offending secret's content. Rejects a role/secret mismatch.
- **`RemoteSigner`** / **`RemoteSignerTransport`** -- adapter shape for a future KMS/HSM signing microservice this Worker would call over HTTPS, holding no key material itself. No such service exists yet (no credentials or endpoint available in this codebase); the interface exists so a real implementation can be dropped in without touching any keeper code.

`createProductionSigner(role, secret?)` throws a clear, non-key-revealing error when `secret` is omitted (blocks *live* deployment for that role, not code completion) and constructs a real `SecretBackedSigner` when one is supplied.

`SignerRole` / `SignerRegistry` make "one signer per keeper role" (`pyth`, `magicblock-commit`, `funding`, `market-session`, `expiry-cleanup`, `liquidation`) a structural fact, not a convention: a registry is built once with exactly one signer per role and `for(role)` only returns signers this module constructed. A keeper signer is never the program's upgrade authority, a user's own withdrawal authority, or a Privy embedded user wallet -- none of those are `Signer` implementations anywhere in this module, which is the actual enforcement.

Cryptography: every real adapter uses the Workers-native `crypto.subtle` Ed25519 implementation (verified working in the `vitest-pool-workers` runtime this session), not a new dependency or a hand-rolled curve implementation.

## Transaction transports (`workers/src/chain-transports.ts`)

Originally a read-only indexer transport (`account`, `signatures`, `transaction`, `status`). Extended this session with the write path every keeper needs, shared between `SolanaL1Transport` and `MagicRouterTransport` via a common `TransactionTransport` base (an ephemeral-rollup validator speaks the same Solana JSON-RPC methods for these operations):

- `latestBlockhash(commitment)`, `multipleAccounts(addresses, commitment)`, `signatureStatuses(signatures)`, `simulateTransaction(base64Tx, commitment)`, `sendTransaction(base64Tx, options)`, `blockHeight(commitment)`.
- `confirmTransaction(signature, options)`: polls `signatureStatuses` until the target commitment is reached, distinguishing **confirmed** from **finalized** via the RPC's own `confirmationStatus` field (never inferred from elapsed time); detects **blockhash expiry** by comparing the network's current block height against the blockhash's own `lastValidBlockHeight` once a signature stops being observable; **times out** otherwise. Returns a typed outcome (`confirmed | finalized | failed | blockhash_expired | timeout`) rather than throwing.
- `classifyRpcError(error)`: `retryable | permanent | unknown`, from known transient-vs-terminal RPC error message patterns.
- `withRetry(operation, maxAttempts)`: bounded exponential backoff (via `backoff.ts`'s shared schedule), scoped deliberately to safe, idempotent operations. `sendTransaction` is never wrapped in automatic retry: a lost response doesn't mean the transaction wasn't accepted, so blind retry risks double submission that only a keeper's own idempotency key and confirm-before-retry check can safely resolve.
- `classifyWritableAccountDomain(accountBytes)`: reads a market account's own `delegation_status` byte (offset 329, verified via `core::mem::offset_of!` against `programs/stockstream/src/state.rs::RESERVED_DELEGATION_STATUS`, not hand-computed) to decide whether a writable account's next transaction should route to L1 or the ER -- `Delegated` (1) and `Undelegating` (2) both route to the ER (Undelegating is still ER-authoritative until the delegation program's external-undelegate callback lands); `NotDelegated` (0) and `Restored` (3) route to L1. **A real bug was found and fixed here this session**: the routing set originally checked for `Undelegating` at value `4`; the real enum value is `2`. The mismatch shipped once because the corresponding test used the same wrong value on both sides.
- `MagicBlockErTransport` is kept as an alias for the new `MagicRouterTransport` class so existing callers (`ingestion-pipeline.ts`, `private-sessions.ts`) are unaffected.

## The six keeper jobs (`workers/src/keeper-jobs.ts`)

Every job shares one execution shape: acquire a per-market durable lease with a fencing token (`ProtocolRepository.acquire`), generate a deterministic idempotency key, read authoritative on-chain state through the transports above, decide whether there's real work to do, submit, confirm, record the attempt (`TxAttemptRepository`, new `tx_attempts` table), classify failures for retry (`classifyRpcError`), dead-letter exhausted ones (`runDurableKeeperWithDeadLetter`), release the lease.

1. **Pyth oracle keeper** -- durably dedups by `(timestamp, payload hash)` via `OracleUpdateRepository` (wires up the previously-unused `oracle_updates` table), survives a Worker restart unlike the in-memory dedup in `lib/server/pyth-keeper.ts::PythKeeper`.
2. **MagicBlock commit keeper** -- enforces the 30-second commit interval; tracks the last *requested* sequence via `CommitRecordRepository` (wires up the previously-unused `commit_records` table) so a duplicate tick with no new ER sequence is a no-op and never double-commits a sequence.
3. **Funding keeper** -- refuses to settle funding on an unverified oracle; enforces its own configured funding interval independent of the on-chain monotonicity check `update_funding` already provides.
4. **Market session/holiday keeper** -- `sessionTransitionFor` is a pure, independently-tested function mapping a *configured* calendar status to a mode transition; the keeper never invents an oracle-driven status of its own.
5. **Expiry/invalid-order cleanup keeper** -- bounded 32-order sweeps with a durable continuation cursor (`KeeperCursorRepository`, new `keeper_cursors` table) that wraps back to the start once the whole book has been walked, so a restart resumes mid-sweep.
6. **Liquidation keeper** -- always re-reads authoritative seat state via an injected `reReadSeat` before submitting; both the go/no-go decision and the liquidation quantity used come only from that re-read, never from whatever projection-sourced candidate triggered the check.

### The one deliberately interfaced-out piece

`TransactionBuilder<TInput>` -- real Solana wire-format transaction construction and signing. Encoding a StockStream instruction and serializing a signed transaction message needs the same `@solana/web3.js`-shaped primitives `clients/stockstream/src/index.ts` and `lib/server/pyth-keeper.ts` already use, and neither is a dependency of this `workers/` package (its `package.json` has zero runtime dependencies). Hand-rolling a second, parallel wire-format serializer under this session's time budget risked a subtle, untested encoding bug in code that moves funds. Every other part of every keeper job -- lease/fencing, idempotency, on-chain reads, dedup/interval/sequence decisions, submission, confirmation, durable attempt storage, retry classification, dead-lettering -- is real and tested end to end against a real mock JSON-RPC HTTP handler and a real D1 database.

Closing this gap in a future session means either adding `@solana/web3.js` (or an equivalent minimal wire-format encoder) as a `workers/` dependency, or routing this Worker's transaction construction through a call to the Next.js backend's own instruction-building code.

## Testing

`workers/src/chain-transports.test.ts` (28 tests), `workers/src/signer.test.ts` (19 tests), `workers/src/keeper-jobs.test.ts` (19 tests), `workers/src/repositories.test.ts` (new repository classes). All against a real mock JSON-RPC HTTP handler (parses the actual request body, returns the real `{jsonrpc, id, result}` envelope shape) and a real D1 database via `applyD1Migrations`, never a stubbed transport/repository interface.
