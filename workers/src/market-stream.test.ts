import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { SolanaL1Transport } from './chain-transports';
import { PrivateSessionRepository, issuePrivateProjectionToken, seatOwner } from './private-sessions';
import type { MarketEvent, MarketSnapshot } from './types';

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

const TRADER_SEAT_OFFSET = 181_792;
function marketAccountWithSeatOwner(seatIndex: number, owner: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(TRADER_SEAT_OFFSET + 128 * 256);
  const start = TRADER_SEAT_OFFSET + seatIndex * 256;
  bytes[start] = 1;
  bytes.set(owner, start + 1);
  return bytes;
}
async function issueToken(marketPda: string, seatIndex: number, ownerByte: number) {
  const owner = new Uint8Array(32).fill(ownerByte);
  let binary = ''; for (const byte of marketAccountWithSeatOwner(seatIndex, owner)) binary += String.fromCharCode(byte);
  const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { data: [btoa(binary), 'base64'], owner: 'p', lamports: 1 } } }), { headers: { 'content-type': 'application/json' } }));
  const transport = new SolanaL1Transport('https://l1.test', fetcher);
  const repo = new PrivateSessionRepository(bindings.DB!);
  const wallet = (await seatOwner(transport, marketPda, seatIndex))!;
  const { token } = await issuePrivateProjectionToken(repo, transport, wallet, marketPda, seatIndex, 60_000, Date.now());
  return { token, wallet };
}
async function connect(name: string, query = ''): Promise<Response> {
  return env.MARKET_STREAM!.getByName(name).fetch(new Request(`https://test/stream${query}`, { headers: { Upgrade: 'websocket' } }));
}
function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.addEventListener('message', (ev) => resolve(String(ev.data)), { once: true }));
}
function event(sequence: number, kind: MarketEvent['kind'] = 'fill'): MarketEvent {
  return { id: `event-${sequence}`, symbol: 'TEST', domain: 'er', sequence, kind, payload: { quantity: '4' }, observedAt: 1000 };
}
it('persists globally increasing per-domain sequences and ignores duplicates', async () => {
  const stream = env.MARKET_STREAM!.getByName('sequence-test');
  expect(await stream.publish(event(1))).toBe('applied');
  expect(await stream.publish(event(2, 'book'))).toBe('applied');
  expect(await stream.publish(event(1))).toBe('duplicate');
  const response = await env.MARKET_STREAM!.getByName('sequence-test').fetch(new Request('https://test/snapshot'));
  const result = await response.json<{domains: {sequence: number; events: MarketEvent[]}[]}>();
  expect(result.domains[1].sequence).toBe(2);
  expect(result.domains[1].events).toHaveLength(2);
});
it('stops on gaps and resumes only after authoritative snapshot replacement', async () => {
  const stream = env.MARKET_STREAM!.getByName('gap-test');
  expect(await stream.publish(event(2))).toBe('gap');
  expect(await stream.publish(event(1))).toBe('gap');
  const snapshot: MarketSnapshot = { symbol: 'TEST', domain: 'er', sequence: 2, capturedAt: 1000, events: [],
    market: { symbol:'TEST', instrumentId:'test', marketIndex:1, marketPda:'market',vaultPda:'vault',status:'paused',oracleFeedId:'test',sessionPolicy:'regular' } };
  await stream.replaceSnapshot(snapshot);
  expect(await stream.publish(event(3))).toBe('applied');
  expect(await stream.replaceSnapshot({ ...snapshot, sequence: 1 })).toEqual({ accepted: false, reason: 'stale_snapshot' });
  const response = await stream.fetch(new Request('https://test/snapshot'));
  expect((await response.json<{domains: {resynchronizing: boolean}[]}>()).domains[1].resynchronizing).toBe(false);
});
it('websocket reconnect receives a persisted snapshot', async () => {
  const stream = env.MARKET_STREAM!.getByName('socket-test');
  await stream.publish(event(1));
  const response = await stream.fetch(new Request('https://test/stream', { headers: { Upgrade:'websocket' } }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const message = await new Promise<string>(resolve => socket.addEventListener('message', ev => resolve(String(ev.data)), {once:true}));
  expect(JSON.parse(message).domains[1].sequence).toBe(1);
  socket.close();
});

it('delivers a private message only to the socket whose verified token matches the wallet and seat', async () => {
  const marketPda = 'private-market-1';
  const { token, wallet } = await issueToken(marketPda, 3, 9);
  const ownerResponse = await connect('private-room-1', `?token=${token}&market=${marketPda}`);
  expect(ownerResponse.status).toBe(101);
  const ownerSocket = ownerResponse.webSocket!;
  ownerSocket.accept();
  await nextMessage(ownerSocket); // initial snapshot

  const publicResponse = await connect('private-room-1');
  expect(publicResponse.status).toBe(101);
  const publicSocket = publicResponse.webSocket!;
  publicSocket.accept();
  await nextMessage(publicSocket); // initial snapshot

  const stream = env.MARKET_STREAM!.getByName('private-room-1');
  const privateReceived = nextMessage(ownerSocket);
  let publicReceivedPrivate = false;
  publicSocket.addEventListener('message', (ev) => { if (String(ev.data).includes('collateral')) publicReceivedPrivate = true; });
  await stream.publishPrivate('irrelevant-check', 3, { availableCollateral: '500' });
  // The call above used a wallet that does not match the issued token's
  // wallet on purpose -- it must reach no one.
  await stream.publishPrivate(wallet, 3, { availableCollateral: '500' });
  const message = JSON.parse(await privateReceived);
  expect(message).toEqual({ type: 'private', payload: { availableCollateral: '500' } });
  expect(publicReceivedPrivate).toBe(false);
  ownerSocket.close(); publicSocket.close();
});

it('rejects a different wallet/seat than the one the token was issued for', async () => {
  const marketPda = 'private-market-2';
  const { token, wallet } = await issueToken(marketPda, 1, 11);
  const response = await connect('private-room-2', `?token=${token}&market=${marketPda}`);
  const socket = response.webSocket!; socket.accept();
  await nextMessage(socket);
  const stream = env.MARKET_STREAM!.getByName('private-room-2');
  let received = false;
  socket.addEventListener('message', () => { received = true; });
  await stream.publishPrivate(wallet, 2, { note: 'different seat' }); // same wallet, wrong seat
  await stream.publishPrivate('someone-else', 1, { note: 'different wallet' }); // same seat, wrong wallet
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toBe(false);
  socket.close();
});

it('rejects the WebSocket upgrade outright for an invalid or expired token rather than downgrading to public', async () => {
  const marketPda = 'private-market-3';
  const badToken = await connect('private-room-3', `?token=not-a-real-token&market=${marketPda}`);
  expect(badToken.status).toBe(401);
  const missingMarket = await connect('private-room-3', `?token=whatever`);
  expect(missingMarket.status).toBe(400);
});

it('never includes private fields in the public snapshot/delta stream', async () => {
  const marketPda = 'private-market-4';
  await issueToken(marketPda, 0, 12); // establishes a real seat owner, unused here
  const stream = env.MARKET_STREAM!.getByName('private-room-4');
  await stream.publish(event(1));
  const response = await stream.fetch(new Request('https://test/snapshot'));
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain('availableCollateral');
  expect(body).not.toContain('"private"');
});
