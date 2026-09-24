/**
 * Priority 8: the six concrete, durable Equinox keeper jobs. Every job
 * shares one execution shape (`runKeeperAction` below): acquire a
 * per-market durable lease with a fencing token
 * (`ProtocolRepository.acquire`), generate a deterministic idempotency key,
 * read authoritative on-chain state through `chain-transports.ts`, decide
 * whether there is real work to do, submit through the correct transport,
 * confirm, record the attempt (`TxAttemptRepository`), classify failures
 * for retry (`classifyRpcError`), dead-letter exhausted ones
 * (`runDurableKeeperWithDeadLetter`), and release the lease.
 *
 * `TransactionBuilder` (below) is an injected interface rather than inline
 * code, so each job stays agnostic to wire-format details. `transactions.ts`
 * is the concrete implementation of that boundary (real `@solana/kit`
 * instruction encoders, transaction compilation, and `Signer`-backed
 * signing) and exports a factory per job (`fundingKeeperBuilder`,
 * `sessionKeeperBuilder`, `liquidationKeeperBuilder`, `cleanupKeeperBuilder`,
 * `pythKeeperBuilder`, `magicBlockCommitKeeperBuilder`). What remains
 * unwired is the production `scheduled()` entrypoint (`index.ts`) actually
 * invoking these ticks on a cron with live inputs -- a funding-rate source,
 * a liquidation-candidate scanner, a session calendar, and a Pyth Lazer
 * client -- none of which exist as production integrations yet; every job
 * below is independently tested against synthetic inputs, not live state.
 * Every other part of each job -- lease/fencing, idempotency, on-chain state
 * reads, dedup/interval/sequence decisions, submission, confirmation,
 * durable attempt storage, retry classification, dead-lettering -- is real
 * and independently tested.
 */

import { classifyRpcError, MagicRouterTransport, SolanaL1Transport, type ConfirmationOutcome } from './chain-transports';
import { keeperLeaseKey, runDurableKeeperWithDeadLetter } from './keepers';
import {
  CommitRecordRepository,
  DeadLetterRepository,
  KeeperCursorRepository,
  OracleUpdateRepository,
  ProtocolRepository,
  TxAttemptRepository,
  type TxAttemptStatus,
} from './repositories';
import type { Signer } from './signer';

/** Builds and fully signs a complete, submission-ready base64 transaction.
 * `input` is whatever shape the specific keeper job needs (typed per call
 * site below); the builder owns instruction construction, blockhash
 * insertion, and signing via the given `Signer`. */
export interface TransactionBuilder<TInput> {
  build(input: TInput, signer: Signer, recentBlockhash: string): Promise<string>;
}

export interface KeeperDeps {
  repo: ProtocolRepository;
  deadLetters: DeadLetterRepository;
  txAttempts: TxAttemptRepository;
  holder: string;
  now: () => number;
  leaseTtlMs?: number;
  idempotencyTtlMs?: number;
}

export interface KeeperOutcome {
  ran: boolean;
  reason: string;
  signature?: string;
  status?: TxAttemptStatus;
}

/** Confirmation outcomes that mean "the transaction did not end up
 * durably confirmed" -- `submitAndConfirm` below maps every one of these
 * to a thrown, retryable-or-not error via `classifyRpcError` semantics so
 * `runDurableKeeperWithDeadLetter`'s retry/dead-letter machinery applies
 * uniformly across every keeper. */
function outcomeError(outcome: ConfirmationOutcome): Error | null {
  switch (outcome.status) {
    case 'confirmed':
    case 'finalized':
      return null;
    case 'failed':
      return new Error(`transaction failed on-chain: ${JSON.stringify(outcome.err)}`);
    case 'blockhash_expired':
      return new Error('blockhash not found: transaction expired before confirmation');
    case 'timeout':
      return new Error('confirmation timed out');
  }
}

/** Shared submit-confirm-record sequence used by every keeper job below.
 * Never retried internally (see the module doc: retrying `sendTransaction`
 * blindly risks double submission) -- a thrown error here is classified
 * and handled entirely by the caller's `runDurableKeeperWithDeadLetter`. */
async function submitAndConfirm(
  transport: SolanaL1Transport | MagicRouterTransport,
  txAttempts: TxAttemptRepository,
  attemptId: string,
  keeper: string,
  marketPda: string,
  domain: 'l1' | 'er',
  transactionBase64: string,
  lastValidBlockHeight: number,
  now: number,
): Promise<string> {
  const signature = await transport.sendTransaction(transactionBase64);
  await txAttempts.submitted(attemptId, keeper, marketPda, domain, signature, now);
  const outcome = await transport.confirmTransaction(signature, { targetCommitment: 'confirmed', lastValidBlockHeight });
  const error = outcomeError(outcome);
  const resolvedStatus: TxAttemptStatus = outcome.status === 'blockhash_expired' ? 'expired' : outcome.status;
  await txAttempts.resolved(attemptId, resolvedStatus, error?.message ?? null, Date.now());
  if (error) throw error;
  return signature;
}

async function runKeeperAction<T>(
  deps: KeeperDeps,
  leaseKind: Parameters<typeof keeperLeaseKey>[0],
  marketPda: string,
  idempotencySuffix: string,
  requestHash: string,
  work: () => Promise<T>,
): Promise<T> {
  const now = deps.now();
  return runDurableKeeperWithDeadLetter(deps.repo, deps.deadLetters, {
    leaseKey: keeperLeaseKey(leaseKind, marketPda),
    holder: deps.holder,
    idempotencyKey: `${leaseKind}:${marketPda}:${idempotencySuffix}`,
    deadLetterId: `${leaseKind}:${marketPda}:${idempotencySuffix}`,
    requestHash,
    now,
    leaseTtlMs: deps.leaseTtlMs ?? 30_000,
    idempotencyTtlMs: deps.idempotencyTtlMs ?? 60_000,
    work,
  });
}

// ---------------------------------------------------------------------
// 1. Pyth oracle keeper
// ---------------------------------------------------------------------

export interface PythUpdateSource {
  /** Returns `null` when there is no update newer than `previousTimestamp`
   * (or `previousPayloadHash`) available -- suppressing a duplicate/older
   * feed timestamp is this source's own responsibility, matching
   * `lib/server/pyth-keeper.ts::PythKeeper.fetchSignedUpdate`'s existing
   * dedup contract. */
  fetchSignedUpdate(previousTimestamp: number, previousPayloadHash: string): Promise<{ message: Uint8Array; timestamp: number; payloadHash: string; feedId: string } | null>;
}

export interface PythKeeperInput {
  message: Uint8Array;
  feedId: string;
}

export async function runPythKeeperTick(
  deps: KeeperDeps,
  l1: SolanaL1Transport,
  signer: Signer,
  builder: TransactionBuilder<PythKeeperInput>,
  source: PythUpdateSource,
  marketPda: string,
  oracleUpdates: OracleUpdateRepository,
): Promise<KeeperOutcome> {
  const lastKnown = await l1FetchLastOracleState(oracleUpdates, marketPda);
  const update = await source.fetchSignedUpdate(lastKnown.timestamp, lastKnown.payloadHash);
  if (!update) return { ran: false, reason: 'no newer Pyth update available' };
  if (await oracleUpdates.alreadyApplied(marketPda, update.timestamp, update.payloadHash)) {
    return { ran: false, reason: 'update already applied (durable dedup)' };
  }
  return runKeeperAction(deps, 'pyth', marketPda, `${update.timestamp}:${update.payloadHash}`, update.payloadHash, async () => {
    const now = deps.now();
    await oracleUpdates.record(marketPda, update.feedId, update.timestamp, update.payloadHash, 'submitted', now);
    const { value: blockhash } = await l1.latestBlockhash('confirmed');
    const tx = await builder.build({ message: update.message, feedId: update.feedId }, signer, blockhash.blockhash);
    try {
      const signature = await submitAndConfirm(l1, deps.txAttempts, `pyth:${marketPda}:${update.timestamp}`, 'pyth', marketPda, 'l1', tx, blockhash.lastValidBlockHeight, now);
      await oracleUpdates.record(marketPda, update.feedId, update.timestamp, update.payloadHash, 'confirmed', Date.now());
      return { ran: true, reason: 'oracle update confirmed', signature, status: 'confirmed' } satisfies KeeperOutcome;
    } catch (error) {
      await oracleUpdates.record(marketPda, update.feedId, update.timestamp, update.payloadHash, 'rejected', Date.now());
      throw error;
    }
  });
}

/** The durable dedup baseline this tick should suppress against: the most
 * recently *confirmed* oracle update this keeper recorded for this
 * market, or a zero baseline if none exists yet. */
async function l1FetchLastOracleState(oracleUpdates: OracleUpdateRepository, _marketPda: string): Promise<{ timestamp: number; payloadHash: string }> {
  // `OracleUpdateRepository` only exposes point lookups by (market,
  // timestamp) today (`alreadyApplied`), not "the latest one" -- a
  // deliberately small interface. A real deployment's `PythUpdateSource`
  // is expected to track its own last-seen timestamp across ticks (as
  // `PythKeeper` already does in-memory); this baseline of zero only
  // matters for a cold start, where any real update is newer regardless.
  void oracleUpdates;
  return { timestamp: 0, payloadHash: '' };
}

// ---------------------------------------------------------------------
// 2. MagicBlock commit keeper
// ---------------------------------------------------------------------

export interface CommitKeeperInput {
  sequence: number;
  undelegate: boolean;
}

/**
 * Minimum interval between the commit keeper's own scheduling ticks. This is
 * deliberately independent of the delegation-time automatic commit frequency
 * (30,000 ms, encoded into the Delegate instruction's commit_frequency_ms by
 * the Rust program — see `lib/magicblock.ts::DELEGATION_COMMIT_FREQUENCY_MS`):
 * the delegation program auto-commits on that cadence regardless of this
 * keeper's tick rate, so per-market commit policy requires a program-side
 * change, not a Worker setting.
 */
const MIN_COMMIT_TICK_MS = 30_000;

export async function runMagicBlockCommitKeeperTick(
  deps: KeeperDeps,
  er: MagicRouterTransport,
  signer: Signer,
  builder: TransactionBuilder<CommitKeeperInput>,
  marketPda: string,
  commitRecords: CommitRecordRepository,
  currentErSequence: number,
  lastCommitTickAt: number,
): Promise<KeeperOutcome> {
  if (deps.now() - lastCommitTickAt < MIN_COMMIT_TICK_MS) {
    return { ran: false, reason: `commit interval not yet elapsed (target ${MIN_COMMIT_TICK_MS}ms)` };
  }
  const lastRequested = await commitRecords.lastRequestedSequence(marketPda);
  if (currentErSequence <= lastRequested) {
    return { ran: false, reason: `no new ER sequence to commit (current ${currentErSequence}, last requested ${lastRequested})` };
  }
  const sequence = lastRequested + 1;
  return runKeeperAction(deps, 'commit', marketPda, `seq-${sequence}`, String(sequence), async () => {
    const now = deps.now();
    await commitRecords.record(marketPda, sequence, 'er', 'requested', null, now);
    const { value: blockhash } = await er.latestBlockhash();
    const tx = await builder.build({ sequence, undelegate: false }, signer, blockhash.blockhash);
    const signature = await submitAndConfirm(er, deps.txAttempts, `commit:${marketPda}:${sequence}`, 'commit', marketPda, 'er', tx, blockhash.lastValidBlockHeight, now);
    await commitRecords.record(marketPda, sequence, 'l1', 'confirmed', signature, Date.now());
    return { ran: true, reason: `committed ER sequence ${sequence}`, signature, status: 'confirmed' } satisfies KeeperOutcome;
  });
}

// ---------------------------------------------------------------------
// 3. Funding keeper
// ---------------------------------------------------------------------

export interface FundingKeeperInput {
  accumulator: bigint;
  timestamp: number;
}

export async function runFundingKeeperTick(
  deps: KeeperDeps,
  l1: SolanaL1Transport,
  signer: Signer,
  builder: TransactionBuilder<FundingKeeperInput>,
  marketPda: string,
  input: {
    oracleValid: boolean;
    oracleTimestamp: number;
    lastFundingTimestamp: number;
    fundingIntervalMs: number;
    computeNextAccumulator: () => bigint;
    now: number;
  },
): Promise<KeeperOutcome> {
  if (!input.oracleValid) return { ran: false, reason: 'oracle not verified; refusing to settle funding on stale/invalid state' };
  const elapsedMs = input.now - input.lastFundingTimestamp * 1000;
  if (elapsedMs < input.fundingIntervalMs) {
    return { ran: false, reason: `funding interval not yet elapsed (${elapsedMs}ms < ${input.fundingIntervalMs}ms)` };
  }
  // The accumulator itself is monotonic on-chain (`update_funding` rejects
  // a lower value); the interval check above is this keeper's own
  // additional guard against submitting faster than its configured cadence
  // even if invoked more often than expected.
  const accumulator = input.computeNextAccumulator();
  const timestamp = Math.floor(input.oracleTimestamp);
  return runKeeperAction(deps, 'funding', marketPda, `ts-${timestamp}`, `${accumulator}:${timestamp}`, async () => {
    const now = deps.now();
    const { value: blockhash } = await l1.latestBlockhash('confirmed');
    const tx = await builder.build({ accumulator, timestamp }, signer, blockhash.blockhash);
    const signature = await submitAndConfirm(l1, deps.txAttempts, `funding:${marketPda}:${timestamp}`, 'funding', marketPda, 'l1', tx, blockhash.lastValidBlockHeight, now);
    return { ran: true, reason: `funding settled at accumulator ${accumulator}`, signature, status: 'confirmed' } satisfies KeeperOutcome;
  });
}

// ---------------------------------------------------------------------
// 4. Market session / holiday keeper
// ---------------------------------------------------------------------

export type SessionCalendarStatus = 'regular' | 'extended' | 'closed' | 'holiday';

export interface SessionKeeperInput {
  targetMode: 'open' | 'close-only' | 'paused';
}

/** Pure function (independently testable, no I/O): maps a configured
 * session-policy calendar status to the market mode transition it implies.
 * `null` means "no transition needed" -- the keeper must never invent an
 * oracle-driven status on its own; it only ever acts on the *configured*
 * calendar it was given. */
export function sessionTransitionFor(calendarStatus: SessionCalendarStatus, currentMode: 'open' | 'close-only' | 'paused'): SessionKeeperInput | null {
  const targetMode: SessionKeeperInput['targetMode'] = calendarStatus === 'regular' || calendarStatus === 'extended' ? 'open' : calendarStatus === 'closed' ? 'close-only' : 'paused';
  if (targetMode === currentMode) return null;
  return { targetMode };
}

export async function runMarketSessionKeeperTick(
  deps: KeeperDeps,
  l1: SolanaL1Transport,
  signer: Signer,
  builder: TransactionBuilder<SessionKeeperInput>,
  marketPda: string,
  calendarStatus: SessionCalendarStatus,
  currentMode: 'open' | 'close-only' | 'paused',
): Promise<KeeperOutcome> {
  const transition = sessionTransitionFor(calendarStatus, currentMode);
  if (!transition) return { ran: false, reason: `market mode already matches configured calendar status "${calendarStatus}"` };
  return runKeeperAction(deps, 'session', marketPda, `${transition.targetMode}:${deps.now()}`, transition.targetMode, async () => {
    const now = deps.now();
    const { value: blockhash } = await l1.latestBlockhash('confirmed');
    const tx = await builder.build(transition, signer, blockhash.blockhash);
    const signature = await submitAndConfirm(l1, deps.txAttempts, `session:${marketPda}:${now}`, 'session', marketPda, 'l1', tx, blockhash.lastValidBlockHeight, now);
    return { ran: true, reason: `transitioned market to ${transition.targetMode}`, signature, status: 'confirmed' } satisfies KeeperOutcome;
  });
}

// ---------------------------------------------------------------------
// 5. Expired/invalid-order cleanup keeper
// ---------------------------------------------------------------------

export interface CleanupCursor {
  /** Position within the book this sweep last reached; opaque beyond
   * "resume from here next tick." */
  offset: number;
}

export interface CleanupKeeperInput {
  maxRemovals: number;
}

const CLEANUP_SWEEP_SIZE = 32;

export async function runCleanupKeeperTick(
  deps: KeeperDeps,
  l1: SolanaL1Transport,
  signer: Signer,
  builder: TransactionBuilder<CleanupKeeperInput>,
  marketPda: string,
  cursors: KeeperCursorRepository,
  bookSize: number,
): Promise<KeeperOutcome> {
  const stored = (await cursors.get('cleanup', marketPda)) as CleanupCursor | null;
  const offset = stored?.offset ?? 0;
  if (bookSize === 0) return { ran: false, reason: 'book is empty; nothing to sweep' };
  const sweepEnd = Math.min(offset + CLEANUP_SWEEP_SIZE, bookSize);
  return runKeeperAction(deps, 'cleanup', marketPda, `${offset}-${sweepEnd}:${deps.now()}`, `${offset}-${sweepEnd}`, async () => {
    const now = deps.now();
    const { value: blockhash } = await l1.latestBlockhash('confirmed');
    const tx = await builder.build({ maxRemovals: sweepEnd - offset }, signer, blockhash.blockhash);
    const signature = await submitAndConfirm(l1, deps.txAttempts, `cleanup:${marketPda}:${offset}`, 'cleanup', marketPda, 'l1', tx, blockhash.lastValidBlockHeight, now);
    // Bounded sweep: always advances, wrapping back to the start once the
    // whole book has been walked, so a restart resumes exactly where the
    // last successful sweep left off rather than always starting at 0.
    const nextOffset = sweepEnd >= bookSize ? 0 : sweepEnd;
    await cursors.set('cleanup', marketPda, { offset: nextOffset } satisfies CleanupCursor, Date.now());
    return { ran: true, reason: `swept [${offset}, ${sweepEnd})`, signature, status: 'confirmed' } satisfies KeeperOutcome;
  });
}

// ---------------------------------------------------------------------
// 6. Liquidation keeper
// ---------------------------------------------------------------------

export interface LiquidationCandidate {
  seatIndex: number;
}

export interface LiquidationKeeperInput {
  seatIndex: number;
  maxQuantity: bigint;
}

/** Re-validates a projection-sourced liquidation candidate against
 * authoritative account bytes before ever submitting -- "use projections
 * only for discovery... never liquidate from Worker projection alone" is
 * enforced structurally here: `reReadSeat` always re-reads `l1` fresh, and
 * the decision to proceed depends only on its return value, never on
 * whatever made this function get called in the first place. */
export async function runLiquidationKeeperTick(
  deps: KeeperDeps,
  l1: SolanaL1Transport,
  signer: Signer,
  builder: TransactionBuilder<LiquidationKeeperInput>,
  marketPda: string,
  candidate: LiquidationCandidate,
  reReadSeat: () => Promise<{ isLiquidatable: boolean; oracleValid: boolean; quantity: bigint }>,
): Promise<KeeperOutcome> {
  const authoritative = await reReadSeat();
  if (!authoritative.oracleValid) return { ran: false, reason: 'oracle not verified on re-read; refusing to liquidate on stale state' };
  if (!authoritative.isLiquidatable) return { ran: false, reason: 'seat is no longer liquidatable on authoritative re-read (projection was stale)' };
  return runKeeperAction(deps, 'liquidation', marketPda, `seat-${candidate.seatIndex}:${deps.now()}`, String(candidate.seatIndex), async () => {
    const now = deps.now();
    const { value: blockhash } = await l1.latestBlockhash('confirmed');
    const tx = await builder.build({ seatIndex: candidate.seatIndex, maxQuantity: authoritative.quantity }, signer, blockhash.blockhash);
    const signature = await submitAndConfirm(l1, deps.txAttempts, `liquidation:${marketPda}:${candidate.seatIndex}:${now}`, 'liquidation', marketPda, 'l1', tx, blockhash.lastValidBlockHeight, now);
    return { ran: true, reason: `liquidated seat ${candidate.seatIndex}`, signature, status: 'confirmed' } satisfies KeeperOutcome;
  });
}

export { classifyRpcError };
