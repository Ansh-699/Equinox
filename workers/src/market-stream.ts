import { DurableObject } from 'cloudflare:workers';
import type { MarketEvent, MarketSnapshot } from './types';
type Domain = 'l1' | 'er';
type State = { domain: Domain; sequence: number; resynchronizing: number; snapshot_json: string | null };

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
  private broadcast(message: unknown): void {
    const bytes = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { pending: number } | null;
      if ((attachment?.pending ?? 0) >= 64) { socket.close(1013, 'Resnapshot required'); continue; }
      try {
        socket.send(bytes);
        socket.serializeAttachment({ pending: (attachment?.pending ?? 0) + 1 });
      } catch { socket.close(1011, 'Delivery failed'); }
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
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pending: 0 });
    server.send(JSON.stringify({ type: 'snapshot', ...this.snapshotEnvelope() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ack') socket.serializeAttachment({ pending: 0 });
    else if (message === 'snapshot') socket.send(JSON.stringify({ type: 'snapshot', ...this.snapshotEnvelope() }));
    else socket.close(1008, 'Unsupported client message');
  }
  webSocketClose(socket: WebSocket): void { socket.close(); }
  webSocketError(socket: WebSocket): void { socket.close(1011, 'Socket failure'); }
}
