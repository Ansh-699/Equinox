import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { fetchExecutionStatus, fetchV3MarketSnapshot, runIngestionTick, runKeeperOrchestrationTick } from './index';
import { eventLogLine } from './test-event-fixtures';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { STOCKSTREAM_PROGRAM_ID } from '../../clients/stockstream/src/constants';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

const token = 'test-only-ingestion';
function request(path: string, body: unknown): Request {
  return new Request(`https://stockstream.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function v3FixtureAccounts(coreAddress: string): Uint8Array[] {
  const parent = getBase58Encoder().encode(coreAddress);
  const core = new Uint8Array(4_096); core.set(new TextEncoder().encode('STKMK003')); new DataView(core.buffer).setUint16(8, 3, true); core[10] = 1; core[11] = 1; core[371] = 2;
  core.set(parent, 12); core.set(parent, 44);
  const books = Array.from({ length: 18 }, (_, flat) => { const page = new Uint8Array(10_184); page.set(new TextEncoder().encode('STKBK003')); const view = new DataView(page.buffer); view.setUint16(8, 3, true); page[10] = Math.floor(flat / 9); page[11] = flat % 9; page.set(parent, 12); if (page[11] === 0) { view.setUint32(44, 0xffff_ffff, true); view.setUint32(48, 0xffff_ffff, true); } return page; });
  const seats = Array.from({ length: 4 }, (_, shard) => { const bytes = new Uint8Array(8_236); bytes.set(new TextEncoder().encode('STKST003')); const view = new DataView(bytes.buffer); view.setUint16(8, 3, true); bytes[10] = shard; bytes.set(parent, 12); return bytes; });
  const events = Array.from({ length: 4 }, (_, shard) => { const bytes = new Uint8Array(3_244); bytes.set(new TextEncoder().encode('STKEV003')); const view = new DataView(bytes.buffer); view.setUint16(8, 3, true); bytes[10] = shard; bytes.set(parent, 12); return bytes; });
  return [core, ...books, ...seats, ...events];
}

it('fetchV3MarketSnapshot performs one atomic 27-account read and preserves its finalized slot', async () => {
  const coreAddress = getBase58Decoder().decode(new Uint8Array(32).fill(7));
  const accounts = v3FixtureAccounts(coreAddress);
  const requests: { method: string; addresses: unknown[] }[] = [];
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string[]] };
    requests.push({ method: body.method, addresses: body.params[0] });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 77 }, value: accounts.map((bytes) => ({ data: [base64(bytes), 'base64'], owner: STOCKSTREAM_PROGRAM_ID, lamports: 1 })) } });
  }) as unknown as typeof fetch;
  const aggregate = await fetchV3MarketSnapshot({ SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env, coreAddress, 'l1', fetcher);
  expect(aggregate).toMatchObject({ asOfSlot: 77, completeBook: true, completeExecutionState: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: 'getMultipleAccounts' });
  expect(requests[0].addresses).toHaveLength(27);
});

it('routes a registered sequenced event through D1 indexing and rejects a sequence gap', async () => {
  const market = {
    symbol: 'TEST-PERP', instrumentId: 'instrument-test', marketIndex: 500,
    marketPda: 'market-test', vaultPda: 'vault-test', status: 'active',
    oracleFeedId: 'unverified-fixture', sessionPolicy: 'regular',
  };
  expect((await SELF.fetch(request('/v1/ingest/market', market))).status).toBe(202);
  const event = { id: 'event-test-1', symbol: market.symbol, kind: 'fill', payload: { quantity: '1' }, sequence: 1, domain: 'er', slot: 4, observedAt: 100 };
  expect((await SELF.fetch(request('/v1/ingest/market-event', event))).status).toBe(202);
  const gap = await SELF.fetch(request('/v1/ingest/market-event', { ...event, id: 'event-test-3', sequence: 3 }));
  expect(gap.status).toBe(409);
  expect(await gap.json()).toEqual({ error: 'sequence_gap', expected: 2 });
  const cursor = await bindings.DB!.prepare('SELECT sequence FROM indexer_cursors WHERE market_pda=? AND domain=?').bind('market-test', 'er').first<{ sequence: number }>();
  expect(cursor?.sequence).toBe(1);
});

it('runIngestionTick polls a registered market, decodes a real custody log, and ingests it through the durable pipeline', async () => {
  const market = {
    symbol: 'TICK-PERP', instrumentId: 'instrument-tick', marketIndex: 501,
    marketPda: 'tick-market', vaultPda: 'tick-vault', status: 'active',
    oracleFeedId: 'unverified-fixture', sessionPolicy: 'regular',
  };
  expect((await SELF.fetch(request('/v1/ingest/market', market))).status).toBe(202);

  const marketHex = 'ee'.repeat(32);
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { method: string; id: number; params: unknown[] };
    if (body.method === 'getSignaturesForAddress') {
      const address = body.params[0];
      const result = address === market.marketPda ? [{ signature: 'tick-sig-1', slot: 10, err: null }] : [];
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }
    if (body.method === 'getTransaction') {
      return Response.json({
        jsonrpc: '2.0', id: body.id,
        result: {
          slot: 10,
          transaction: { signatures: ['tick-sig-1'] },
          meta: { err: null, logMessages: [eventLogLine(400, 1, marketHex)] },
        },
      });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;

  const result = await runIngestionTick(
    { ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env,
    fetcher,
  );
  // marketsPolled reflects every registered market (this D1 database is
  // shared with other tests in this file), but only this one has any new
  // signature in the fixture fetcher above.
  expect(result.marketsPolled).toBeGreaterThanOrEqual(1);
  expect(result.eventsIngested).toBe(1);
  const cursor = await bindings.DB!.prepare('SELECT sequence FROM indexer_cursors WHERE market_pda=? AND domain=?').bind('tick-market', 'l1').first<{ sequence: number }>();
  expect(cursor?.sequence).toBe(1);

  // A second tick with the same (already-processed) signature must not
  // re-ingest it.
  const again = await runIngestionTick({ ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env, fetcher);
  expect(again.eventsIngested).toBe(0);
});

it('runIngestionTick is a no-op when no RPC endpoint is configured, rather than throwing', async () => {
  const result = await runIngestionTick({ ...bindings, SOLANA_RPC_URL: undefined } as unknown as Env);
  expect(result).toEqual({ marketsPolled: 0, eventsIngested: 0 });
});

it('fetchExecutionStatus reconciles from real transports, persists, and publishes to the Durable Object', async () => {
  const market = {
    symbol: 'EXEC-PERP', instrumentId: 'instrument-exec', marketIndex: 900,
    marketPda: 'exec-market', vaultPda: 'exec-vault', status: 'active',
    oracleFeedId: 'unverified-fixture', sessionPolicy: 'regular',
  };
  expect((await SELF.fetch(request('/v1/ingest/market', market))).status).toBe(202);

  const marketBytes = new Uint8Array(500);
  marketBytes[329] = 1; // DelegationStatus::Delegated
  let binary = ''; for (const b of marketBytes) binary += String.fromCharCode(b);
  const accountResponse = Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 10 }, value: { data: [btoa(binary), 'base64'], owner: 'prog', lamports: 1 } } });
  const fetcher = vi.fn(async () => accountResponse.clone()) as unknown as typeof fetch;

  const stream = env.MARKET_STREAM!.getByName('EXEC-PERP');
  const result = await fetchExecutionStatus({ ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env, 'EXEC-PERP', stream, fetcher);
  expect(result).not.toBe('not_found');
  expect(result).not.toBeUndefined();
  expect((result as { status: string }).status).toBe('er_active');
  expect((result as { withdrawalDisplaySafe: boolean }).withdrawalDisplaySafe).toBe(false);

  const persisted = await bindings.DB!.prepare('SELECT status FROM execution_status WHERE market_pda=?').bind('exec-market').first<{ status: string }>();
  expect(persisted?.status).toBe('er_active');
});

it('fetchExecutionStatus reports undefined without an RPC endpoint configured, and not_found for an unregistered market', async () => {
  expect(await fetchExecutionStatus({ ...bindings, SOLANA_RPC_URL: undefined } as unknown as Env, 'EXEC-PERP', env.MARKET_STREAM!.getByName('x'))).toBeUndefined();
  const fetcher = vi.fn() as unknown as typeof fetch;
  expect(await fetchExecutionStatus({ ...bindings, SOLANA_RPC_URL: 'https://l1.fixture.test' } as unknown as Env, 'NOPE-PERP', env.MARKET_STREAM!.getByName('x'), fetcher)).toBe('not_found');
});

it('reports keeper health (leases, due dead letters, and job configuration), and requires authorization', async () => {
  const unauthorized = await SELF.fetch(new Request('https://stockstream.test/v1/health/keepers'));
  expect(unauthorized.status).toBe(401);
  const response = await SELF.fetch(new Request('https://stockstream.test/v1/health/keepers', { headers: { Authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(200);
  const body = await response.json<{ deadLetters: { due: number }; leases: unknown[]; keeperConfiguration: { pyth: string; signer: string; magicRouter: string } }>();
  expect(typeof body.deadLetters.due).toBe('number');
  expect(Array.isArray(body.leases)).toBe(true);
  expect(body.keeperConfiguration.signer).toBe('configuration_blocked');
});

it('runKeeperOrchestrationTick is a no-op when no RPC endpoint is configured, rather than throwing', async () => {
  const result = await runKeeperOrchestrationTick({ ...bindings, SOLANA_RPC_URL: undefined } as unknown as Env);
  expect(result.ran).toBe(false);
});

it('runKeeperOrchestrationTick discovers a registered market and produces a summary without a keeper signer configured', async () => {
  await bindings.DB!.prepare(
    `INSERT INTO markets (symbol, instrument_id, market_index, market_pda, vault_pda, status, oracle_feed_id, session_policy, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET market_pda=excluded.market_pda`,
  ).bind('ORCH-PERP', 'instrument-orch', 9001, 'orch-market-pda', 'orch-vault', 'active', 'feed-orch', 'regular', Date.now()).run();

  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { id: number; method: string };
    if (body.method === 'getMultipleAccounts') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: [null] } });
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;

  // A devnet-recognized endpoint: the devnet-only guard must not block the
  // orchestration tick in this scenario (no signer configured -> observation-only).
  const result = await runKeeperOrchestrationTick({ ...bindings, SOLANA_RPC_URL: 'http://localhost:8899' } as unknown as Env, fetcher);
  expect(result.ran).toBe(true);
  // The fixture market's account can't be decoded (mock returns null), so
  // it's excluded from results and recorded as a discovery error instead
  // -- one broken market must never throw out of the scheduled tick.
  expect(result.summary?.discoveryErrors.some((e) => e.marketPda === 'orch-market-pda')).toBe(true);
});

it('e2e test mode bypasses Privy verification for the exact sentinel token, but never for a real-looking one', async () => {
  const relaySession = (bearer: string) => new Request('https://stockstream.test/v1/relay/session', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'x-stockstream-relayer-service-token': 'test-only-relayer-service-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      transactionBase64: 'not-a-real-transaction',
      sessionSignerAddress: '11111111111111111111111111111111111111111',
      ownerWallet: '11111111111111111111111111111111111111111',
      expectedMarket: '11111111111111111111111111111111111111111',
    }),
  });

  // The sentinel token skips Privy entirely and reaches real shape
  // validation, which then rejects the garbage transaction -- proof the
  // bypass only ever substitutes the identity check, never the rest of
  // the authoritative chain.
  const bypassed = await SELF.fetch(relaySession('e2e-test-token'));
  expect(bypassed.status).toBe(400);
  expect(await bypassed.json()).toEqual({ error: 'malformed transaction' });

  // Any other bearer value (not the exact sentinel) must still require
  // real Privy configuration, even with E2E_TEST_MODE=1 set -- the bypass
  // is gated on the literal token match, not just the env flag.
  const notBypassed = await SELF.fetch(relaySession('some-other-token'));
  expect(notBypassed.status).toBe(503);
  expect(await notBypassed.json()).toEqual({ error: 'privy_unconfigured' });
});
