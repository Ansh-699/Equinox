/**
 * Always-on devnet market maker for the V3 TSLA-PERP book, as a Durable
 * Object driven by its own alarm and created with the `apac-se` location hint
 * (see src/index.ts), next to the MagicBlock devnet-as validator in
 * Singapore: every quote is a round trip to the rollup. The DO keeps the
 * clock, counters and recent-transaction feed; the tick itself is
 * src/mm-tick.ts. It also refreshes the Pyth snapshot (keeper-paid,
 * permissionless) when the rollup's copy gets old. The bots use their own
 * keys (MM_MAKER_KEYPAIR_JSON / MM_TAKER_KEYPAIR_JSON), never the market
 * authority. Quotes expire after 60 s, so a stalled bot leaves no stale book.
 */
import { runMakerTick, type ErTx, type TickMemo } from "./mm-tick";
import { runOracleRefresh } from "./oracle-runner";

export type { ErTx } from "./mm-tick";
const TICK_MS = 400;
const RECENT_TXS = 60;
interface Status {
  running: boolean; ticks: number; quotes: number; takes: number; cancelled: number; replaced: number; errors: number;
  lastTickAt: number | null; lastPrice: number | null; lastError: string | null; maker: string | null; taker: string | null;
  resting: number; recent: ErTx[]; colo: string | null; pingMs: number | null;
}

export class MarketMaker implements DurableObject {
  private status: Status = { running: false, ticks: 0, quotes: 0, takes: 0, cancelled: 0, replaced: 0, errors: 0, lastTickAt: null, lastPrice: null, lastError: null, maker: null, taker: null, resting: 0, recent: [], colo: null, pingMs: null };
  private memo: TickMemo = { clientId: String(BigInt(Date.now()) * 1_000n), nextTake: 0 };

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    state.blockConcurrencyWhile(async () => {
      this.status.running = (await state.storage.get<boolean>("running")) ?? false;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/start" || path === "/ensure") {
      if (path === "/start") { this.status.running = true; await this.state.storage.put("running", true); }
      // Re-arm a lapsed alarm (the cron calls /ensure every minute).
      if (this.status.running && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 500);
    } else if (path === "/stop") {
      this.status.running = false;
      await this.state.storage.put("running", false);
      await this.state.storage.deleteAlarm();
    }
    return Response.json(this.status);
  }

  async alarm(): Promise<void> {
    if (!this.status.running) return;
    try {
      await this.tick();
    } catch (error) {
      this.status.errors += 1;
      this.status.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    } finally {
      this.status.ticks += 1;
      this.status.lastTickAt = Date.now();
      if (this.status.running) await this.state.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  private async tick() {
    const result = await runMakerTick(this.env, this.memo);
    this.memo = result.memo;
    const s = this.status;
    s.maker = result.maker; s.taker = result.taker; s.colo = result.colo;
    s.pingMs = s.pingMs === null ? result.pingMs : Math.round(s.pingMs * 0.8 + result.pingMs * 0.2);
    if (result.stale) {
      // Quote next tick, once the rollup has cloned the new price.
      const refreshed = await runOracleRefresh(this.env);
      if (refreshed.status === "failed") throw new Error(`oracle refresh failed: ${refreshed.reason}`);
      return;
    }
    s.lastPrice = result.lastPrice; s.resting = result.resting;
    s.quotes += result.quotes; s.replaced += result.replaced; s.cancelled += result.cancelled; s.takes += result.takes;
    s.recent = [...result.recent, ...s.recent].slice(0, RECENT_TXS);
    s.lastError = result.socketError ? `latency socket: ${result.socketError}` : null;
  }
}
