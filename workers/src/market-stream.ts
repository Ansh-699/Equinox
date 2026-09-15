import { DurableObject } from "cloudflare:workers";

import type { MarketEvent } from "./types";

export class MarketStream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS latest_event (
          kind TEXT PRIMARY KEY,
          event_json TEXT NOT NULL
        )
      `);
    });
  }

  publish(event: MarketEvent): void {
    const serialized = JSON.stringify(event);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO latest_event (kind, event_json) VALUES (?, ?)",
      event.kind,
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

  snapshot(): MarketEvent[] {
    return this.ctx.storage.sql
      .exec<{ event_json: string }>("SELECT event_json FROM latest_event ORDER BY kind")
      .toArray()
      .map(({ event_json }) => JSON.parse(event_json) as MarketEvent);
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return Response.json({ events: this.snapshot() });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", events: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(): void {
    // The stream is intentionally server-push only. Clients cannot inject market data.
  }
}
