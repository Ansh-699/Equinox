import { DurableObject } from "cloudflare:workers";

import type { MarketEvent } from "./types";

export class MarketStream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS latest_event (
          kind TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL DEFAULT 0,
          event_json TEXT NOT NULL
        )
      `);
    });
  }

  publish(event: MarketEvent): void {
    const serialized = JSON.stringify(event);
    const sequence = event.sequence ?? 0;
    const previous = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM latest_event WHERE kind = ?", event.kind).toArray()[0];
    if (previous && sequence <= previous.sequence) return;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO latest_event (kind, sequence, event_json) VALUES (?, ?, ?)",
      event.kind,
      sequence,
      serialized,
    );

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        socket.close(1011, "Unable to deliver market update");
      }
    }
  }

  snapshotEnvelope(): { events: MarketEvent[]; sequence: number } {
    const rows = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM latest_event ORDER BY sequence DESC LIMIT 1").toArray();
    return { events: this.snapshot(), sequence: rows[0]?.sequence ?? 0 };
  }

  snapshot(): MarketEvent[] {
    return this.ctx.storage.sql
      .exec<{ event_json: string }>("SELECT event_json FROM latest_event ORDER BY kind")
      .toArray()
      .map(({ event_json }) => JSON.parse(event_json) as MarketEvent);
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return Response.json(this.snapshotEnvelope());
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", ...this.snapshotEnvelope() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(): void {
    // The stream is intentionally server-push only. Clients cannot inject market data.
  }
}
