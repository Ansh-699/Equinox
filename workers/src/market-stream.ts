import { DurableObject } from 'cloudflare:workers';
import { PrivateSessionRepository } from './private-sessions';
import type { MarketEvent, MarketSnapshot } from './types';
type Domain = 'l1' | 'er';
type State = { domain: Domain; sequence: number; resynchronizing: number; snapshot_json: string | null };
/** Present on a socket's attachment only once its `?token=` has been
 * verified against a real on-chain-owned trader seat (`private-sessions.ts`).
 * A socket with no `private` field is public-only: it can never receive a
 * `publishPrivate` message, by construction (see `broadcast`'s public path
 * versus `publishPrivate` below -- they are never the same send loop). */
type PrivateContext = { wallet: string; seatIndex: number };
type Attachment = { pending: number; private?: PrivateContext };

export class MarketStream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS stream_state (
        domain TEXT PRIMARY KEY, sequence INTEGER NOT NULL, resynchronizing INTEGER NOT NULL, snapshot_json TEXT)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS stream_events (
        domain TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(domain,sequence), UNIQUE(domain,id))`);
    });
  }
  private state(domain: Domain): State {
    return this.ctx.storage.sql.exec<State>('SELECT * FROM stream_state WHERE domain=?', domain).toArray()[0]
      ?? { domain, sequence: 0, resynchronizing: 0, snapshot_json: null };
  }
  /** The public path: every connected socket receives the exact same
   * bytes, public data only. Never called with anything containing
   * private per-trader fields -- `publishPrivate` below is the only path
   * that can ever reach a private field, and it never broadcasts. */
  private broadcast(message: unknown): void {
    const bytes = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if ((attachment?.pending ?? 0) >= 64) { socket.close(1013, 'Resnapshot required'); continue; }
      try {
        socket.send(bytes);
        socket.serializeAttachment({ ...attachment, pending: (attachment?.pending ?? 0) + 1 });
      } catch { socket.close(1011, 'Delivery failed'); }
    }
  }
  /** Sends `payload` only to the socket(s) whose verified private context
   * matches both `wallet` and `seatIndex` -- never to any other connected
   * socket, public or otherwise. A caller with the wrong seat/wallet pair
   * reaches no one, not a filtered/redacted version of the event. */
  publishPrivate(wallet: string, seatIndex: number, payload: unknown): void {
    const bytes = JSON.stringify({ type: 'private', payload });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment?.private || attachment.private.wallet !== wallet || attachment.private.seatIndex !== seatIndex) continue;
      try { socket.send(bytes); } catch { socket.close(1011, 'Delivery failed'); }
    }
  }
  publish(event: MarketEvent): 'applied' | 'duplicate' | 'gap' {
    if (!event.domain || !Number.isSafeInteger(event.sequence) || event.sequence! <= 0 || !event.id)
      throw new Error('Invalid sequenced event');
    const state = this.state(event.domain);
    if (event.sequence! <= state.sequence) return 'duplicate';
    if (state.resynchronizing || event.sequence !== state.sequence + 1) {
      this.ctx.storage.sql.exec(`INSERT INTO stream_state VALUES(?,?,1,?) ON CONFLICT(domain)
        DO UPDATE SET resynchronizing=1`, event.domain, state.sequence, state.snapshot_json);
      this.broadcast({ type: 'resynchronizing', domain: event.domain, sequence: state.sequence });
      return 'gap';
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO stream_events VALUES(?,?,?,?)', event.domain!, event.sequence!, event.id, JSON.stringify(event));
      this.ctx.storage.sql.exec(`INSERT INTO stream_state VALUES(?,?,0,?) ON CONFLICT(domain)
        DO UPDATE SET sequence=excluded.sequence`, event.domain!, event.sequence!, state.snapshot_json);
    });
    this.broadcast({ type: 'delta', event });
    return 'applied';
  }
  async replaceSnapshot(snapshot: MarketSnapshot): Promise<{ accepted: boolean; reason?: string }> {
    if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || !['l1','er'].includes(snapshot.domain))
      return { accepted: false, reason: 'invalid_snapshot' };
    if (snapshot.sequence < this.state(snapshot.domain).sequence) return { accepted: false, reason: 'stale_snapshot' };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO stream_state VALUES(?,?,0,?) ON CONFLICT(domain)
        DO UPDATE SET sequence=excluded.sequence,resynchronizing=0,snapshot_json=excluded.snapshot_json`,
        snapshot.domain, snapshot.sequence, JSON.stringify(snapshot));
      this.ctx.storage.sql.exec('DELETE FROM stream_events WHERE domain=? AND sequence<=?', snapshot.domain, snapshot.sequence);
    });
    this.broadcast({ type: 'snapshot', ...this.snapshotEnvelope() });
    return { accepted: true };
  }
  snapshotEnvelope() {
    return { domains: (['l1','er'] as const).map(domain => {
      const state = this.state(domain);
      return { domain, sequence: state.sequence, resynchronizing: Boolean(state.resynchronizing),
        snapshot: state.snapshot_json ? JSON.parse(state.snapshot_json) : null,
        events: this.ctx.storage.sql.exec<{event_json: string}>(
          'SELECT event_json FROM stream_events WHERE domain=? ORDER BY sequence', domain).toArray().map(row => JSON.parse(row.event_json)) };
    }) };
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return Response.json(this.snapshotEnvelope());
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    let privateContext: PrivateContext | undefined;
    if (token) {
      const market = url.searchParams.get('market');
      if (!market) return new Response('market is required with token', { status: 400 });
      if (!this.env.DB) throw new Error('Required storage bindings are unavailable');
      const session = await new PrivateSessionRepository(this.env.DB).verify(token, market, Date.now());
      // A *presented* token that fails verification is rejected outright,
      // never silently downgraded to an anonymous public connection --
      // that would let a caller probe token validity without a clear
      // signal, and would also mean "I asked for my own data" quietly
      // becoming "you get the public feed" instead of an error.
      if (!session) return new Response('invalid or expired private session token', { status: 401 });
      privateContext = { wallet: session.wallet, seatIndex: session.seatIndex };
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pending: 0, private: privateContext } satisfies Attachment);
    server.send(JSON.stringify({ type: 'snapshot', ...this.snapshotEnvelope() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (message === 'ack') socket.serializeAttachment({ ...attachment, pending: 0 });
    else if (message === 'snapshot') socket.send(JSON.stringify({ type: 'snapshot', ...this.snapshotEnvelope() }));
    else socket.close(1008, 'Unsupported client message');
  }
  webSocketClose(socket: WebSocket): void { socket.close(); }
  webSocketError(socket: WebSocket): void { socket.close(1011, 'Socket failure'); }
}
