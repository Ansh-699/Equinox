import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { MarketEvent, MarketSnapshot } from './types';
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
