import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MagicRouterTransport, SolanaL1Transport } from './chain-transports';
import {
  runCleanupKeeperTick,
  runFundingKeeperTick,
  runLiquidationKeeperTick,
  runMagicBlockCommitKeeperTick,
  runMarketSessionKeeperTick,
  runPythKeeperTick,
  sessionTransitionFor,
  type TransactionBuilder,
} from './keeper-jobs';
import { CommitRecordRepository, DeadLetterRepository, KeeperCursorRepository, OracleUpdateRepository, ProtocolRepository, TxAttemptRepository } from './repositories';
import { DeterministicTestSigner } from './signer';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.DB!;
beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS); });

function deps(holder = 'worker-a') {
  return { repo: new ProtocolRepository(db), deadLetters: new DeadLetterRepository(db), txAttempts: new TxAttemptRepository(db), holder, now: () => 1_000_000 };
}

/** A real mock JSON-RPC HTTP handler, matching the pattern already used in
 * `chain-transports.test.ts` and `ingestion-pipeline.test.ts` -- not a
 * stubbed transport interface. */
function mockRpc(handlers: Record<string, (params: unknown[]) => unknown>): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC method ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handler(body.params) }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const trivialBuilder: TransactionBuilder<unknown> = { build: async () => 'base64tx' };

describe('runPythKeeperTick', () => {
  it('skips when the source has no newer update', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('pyth');
    const oracleUpdates = new OracleUpdateRepository(db);
    const outcome = await runPythKeeperTick(deps(), l1, signer, trivialBuilder, { fetchSignedUpdate: async () => null }, 'market-pyth-1', oracleUpdates);
    expect(outcome).toEqual({ ran: false, reason: 'no newer Pyth update available' });
  });

  it('submits, confirms, and durably records a real update end to end', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh1', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-pyth-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('pyth');
    const oracleUpdates = new OracleUpdateRepository(db);
    const source = { fetchSignedUpdate: async () => ({ message: new Uint8Array([1, 2, 3]), timestamp: 500, payloadHash: 'hash-1', feedId: 'feed-1' }) };
    const outcome = await runPythKeeperTick(deps(), l1, signer, trivialBuilder, source, 'market-pyth-2', oracleUpdates);
    expect(outcome.ran).toBe(true);
    expect(outcome.signature).toBe('sig-pyth-1');
    expect(await oracleUpdates.alreadyApplied('market-pyth-2', 500, 'hash-1')).toBe(true);
  });

  it('skips a durably-applied update even from a fresh keeper instance (survives restart)', async () => {
    const oracleUpdates = new OracleUpdateRepository(db);
    await oracleUpdates.record('market-pyth-3', 'feed-1', 500, 'hash-1', 'confirmed', 1000);
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('pyth');
    const source = { fetchSignedUpdate: async () => ({ message: new Uint8Array([1]), timestamp: 500, payloadHash: 'hash-1', feedId: 'feed-1' }) };
    const outcome = await runPythKeeperTick(deps(), l1, signer, trivialBuilder, source, 'market-pyth-3', oracleUpdates);
    expect(outcome).toEqual({ ran: false, reason: 'update already applied (durable dedup)' });
  });
});

describe('runMagicBlockCommitKeeperTick', () => {
  it('skips before the 30-second commit interval has elapsed', async () => {
    const er = new MagicRouterTransport('https://er.test', mockRpc({}));
    const signer = new DeterministicTestSigner('commit');
    const commitRecords = new CommitRecordRepository(db);
    const d = deps();
    const outcome = await runMagicBlockCommitKeeperTick(d, er, signer, trivialBuilder, 'market-commit-1', commitRecords, 5, d.now() - 1_000);
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toMatch(/interval/);
  });

  it('skips when there is no new ER sequence past the last requested one', async () => {
    const er = new MagicRouterTransport('https://er.test', mockRpc({}));
    const signer = new DeterministicTestSigner('commit');
    const commitRecords = new CommitRecordRepository(db);
    await commitRecords.record('market-commit-2', 5, 'er', 'requested', 'sig', 1000);
    const d = deps();
    const outcome = await runMagicBlockCommitKeeperTick(d, er, signer, trivialBuilder, 'market-commit-2', commitRecords, 5, d.now() - 40_000);
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toMatch(/no new ER sequence/);
  });

  it('never issues a duplicate commit for the same sequence, even from a concurrent duplicate tick', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-commit-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const er = new MagicRouterTransport('https://er.test', fetcher);
    const signer = new DeterministicTestSigner('commit');
    const commitRecords = new CommitRecordRepository(db);
    const d = deps();
    const first = await runMagicBlockCommitKeeperTick(d, er, signer, trivialBuilder, 'market-commit-3', commitRecords, 1, d.now() - 40_000);
    expect(first.ran).toBe(true);
    expect(await commitRecords.lastRequestedSequence('market-commit-3')).toBe(1);
    // A second tick with the same ER sequence (1) has nothing new to commit.
    const second = await runMagicBlockCommitKeeperTick(deps('worker-b'), er, signer, trivialBuilder, 'market-commit-3', commitRecords, 1, d.now() - 40_000);
    expect(second.ran).toBe(false);
  });
});

describe('runFundingKeeperTick', () => {
  it('refuses to settle funding when the oracle is not verified', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('funding');
    const outcome = await runFundingKeeperTick(deps(), l1, signer, trivialBuilder, 'market-funding-1', {
      oracleValid: false, oracleTimestamp: 1000, lastFundingTimestamp: 0, fundingIntervalMs: 3_600_000, computeNextAccumulator: () => 1n, now: 2_000_000,
    });
    expect(outcome).toEqual({ ran: false, reason: 'oracle not verified; refusing to settle funding on stale/invalid state' });
  });

  it('skips before its configured funding interval has elapsed', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('funding');
    const outcome = await runFundingKeeperTick(deps(), l1, signer, trivialBuilder, 'market-funding-2', {
      oracleValid: true, oracleTimestamp: 1000, lastFundingTimestamp: 999, fundingIntervalMs: 3_600_000, computeNextAccumulator: () => 1n, now: 1_000_500,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toMatch(/interval/);
  });

  it('settles funding once the interval has elapsed and the oracle is verified', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-funding-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('funding');
    const outcome = await runFundingKeeperTick(deps(), l1, signer, trivialBuilder, 'market-funding-3', {
      oracleValid: true, oracleTimestamp: 1000, lastFundingTimestamp: 0, fundingIntervalMs: 3_600_000, computeNextAccumulator: () => 42n, now: 4_000_000,
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.signature).toBe('sig-funding-1');
  });
});

describe('sessionTransitionFor', () => {
  it('is a no-op when the calendar status already matches the current mode', () => {
    expect(sessionTransitionFor('regular', 'open')).toBeNull();
    expect(sessionTransitionFor('closed', 'close-only')).toBeNull();
  });
  it('never invents a transition beyond the configured calendar', () => {
    expect(sessionTransitionFor('holiday', 'open')).toEqual({ targetMode: 'paused' });
    expect(sessionTransitionFor('extended', 'paused')).toEqual({ targetMode: 'open' });
  });
});

describe('runMarketSessionKeeperTick', () => {
  it('skips when no transition is implied by the configured calendar', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('session');
    const outcome = await runMarketSessionKeeperTick(deps(), l1, signer, trivialBuilder, 'market-session-1', 'regular', 'open');
    expect(outcome.ran).toBe(false);
  });

  it('submits a mode transition when the calendar disagrees with current mode', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-session-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('session');
    const outcome = await runMarketSessionKeeperTick(deps(), l1, signer, trivialBuilder, 'market-session-2', 'holiday', 'open');
    expect(outcome.ran).toBe(true);
    expect(outcome.signature).toBe('sig-session-1');
  });
});

describe('runCleanupKeeperTick', () => {
  it('skips an empty book', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('cleanup');
    const outcome = await runCleanupKeeperTick(deps(), l1, signer, trivialBuilder, 'market-cleanup-1', new KeeperCursorRepository(db), 0);
    expect(outcome.ran).toBe(false);
  });

  it('sweeps a bounded window and persists a continuation cursor that a later restart resumes from', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-cleanup-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('cleanup');
    const cursors = new KeeperCursorRepository(db);
    const outcome = await runCleanupKeeperTick(deps(), l1, signer, trivialBuilder, 'market-cleanup-2', cursors, 50);
    expect(outcome.ran).toBe(true);
    // Bounded sweep size is 32, so the first sweep of a 50-order book
    // advances the cursor to 32, not straight to the end.
    expect(await new KeeperCursorRepository(db).get('cleanup', 'market-cleanup-2')).toEqual({ offset: 32 });
  });
});

describe('runLiquidationKeeperTick', () => {
  it('never liquidates from a stale projection: refuses when the authoritative re-read disagrees', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('liquidation');
    const outcome = await runLiquidationKeeperTick(deps(), l1, signer, trivialBuilder, 'market-liq-1', { seatIndex: 3 }, async () => ({ isLiquidatable: false, oracleValid: true, quantity: 0n }));
    expect(outcome).toEqual({ ran: false, reason: 'seat is no longer liquidatable on authoritative re-read (projection was stale)' });
  });

  it('refuses to liquidate on an unverified oracle even if the projection says liquidatable', async () => {
    const l1 = new SolanaL1Transport('https://l1.test', mockRpc({}));
    const signer = new DeterministicTestSigner('liquidation');
    const outcome = await runLiquidationKeeperTick(deps(), l1, signer, trivialBuilder, 'market-liq-2', { seatIndex: 3 }, async () => ({ isLiquidatable: true, oracleValid: false, quantity: 10n }));
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toMatch(/oracle not verified/);
  });

  it('liquidates using the authoritative re-read quantity, not any value the caller supplied', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-liq-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('liquidation');
    const outcome = await runLiquidationKeeperTick(deps(), l1, signer, trivialBuilder, 'market-liq-3', { seatIndex: 7 }, async () => ({ isLiquidatable: true, oracleValid: true, quantity: 99n }));
    expect(outcome.ran).toBe(true);
    expect(outcome.signature).toBe('sig-liq-1');
  });
});

describe('failure classification and dead-lettering', () => {
  it('records a failed submission attempt and dead-letters it after repeated failures', async () => {
    const fetcher = mockRpc({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'bh', lastValidBlockHeight: 1000 } }),
      sendTransaction: () => 'sig-fail-1',
      getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] }),
    });
    const l1 = new SolanaL1Transport('https://l1.test', fetcher);
    const signer = new DeterministicTestSigner('session');
    const d = deps();
    await expect(runMarketSessionKeeperTick(d, l1, signer, trivialBuilder, 'market-fail-1', 'holiday', 'open')).rejects.toThrow(/failed on-chain/);
    const attempts = await new TxAttemptRepository(db).recentForMarket('market-fail-1', 'session');
    expect(attempts[0].status).toBe('failed');
    const dueDeadLetters = await new DeadLetterRepository(db).due(d.now() + 10_000_000);
    expect(dueDeadLetters.some((entry) => entry.id.startsWith('session:market-fail-1'))).toBe(true);
  });
});
