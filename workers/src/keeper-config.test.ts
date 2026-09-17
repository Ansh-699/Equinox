import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { buildOrchestratorDeps, classifyKeeperConfiguration } from "./keeper-config";
import { ProtocolKeeperOrchestrator } from "./keeper-orchestrator";

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.DB!;
beforeAll(async () => { await applyD1Migrations(db, bindings.TEST_MIGRATIONS); });

describe("classifyKeeperConfiguration", () => {
  it("reports magicRouter ready only when an ER endpoint is configured", () => {
    expect(classifyKeeperConfiguration({} as Env).magicRouter).toBe("configuration_blocked");
    expect(classifyKeeperConfiguration({ MAGIC_ROUTER_URL: "https://router.test" } as Env).magicRouter).toBe("ready");
  });

  it("reports pyth ready only with a key AND the full three-endpoint redundancy; signer only with validated material", () => {
    // Key present but no endpoints configured -> falls back to the three
    // documented defaults, which with a key IS the documented ready state.
    const health = classifyKeeperConfiguration({ PYTH_PRO_API_KEY: "k" } as Env);
    expect(health.pyth).toBe("ready");
    expect(health.signer).toBe("configuration_blocked");
    // No key at all stays blocked.
    expect(classifyKeeperConfiguration({} as Env).pyth).toBe("configuration_blocked");
  });
});

describe("buildOrchestratorDeps", () => {
  it("returns null when the general-Worker RPC requirement is missing (never crashes the scheduler)", async () => {
    expect(await buildOrchestratorDeps({ DB: db } as Env, fetch, null, undefined)).toBeNull();
    expect(await buildOrchestratorDeps({ SOLANA_RPC_URL: "https://l1.test" } as Env, fetch, null, undefined)).toBeNull();
  });

  it("with no signer and no keeper public key configured, a discovered market runs to observation-only results without throwing", async () => {
    const marketPda = "Market11111111111111111111111111111111111";
    await db
      .prepare(
        `INSERT INTO markets (symbol, market_index, status, oracle_feed_id, updated_at, instrument_id, market_pda, vault_pda, session_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET market_pda=excluded.market_pda`,
      )
      .bind("NOKEY", Math.floor(Math.random() * 1_000_000), "active", "feed-1", Date.now(), "instrument-1", marketPda, "vault-1", "regular")
      .run();

    // A real, decodable (header-only) account -- exercising the actual
    // runMarket path (not just discovery) with no signer and no keeper
    // public key configured, which previously threw eagerly out of
    // buildersFor before any signer-presence check ran.
    const headerBytes = new Uint8Array(512);
    const view = new DataView(headerBytes.buffer);
    headerBytes.set(new TextEncoder().encode("STKMRK01"), 0);
    view.setUint16(8, 2, true);
    view.setUint8(10, 1);
    view.setUint8(11, 1);
    headerBytes.set(getBase58Encoder().encode("SysvarRent111111111111111111111111111111111"), 12);
    headerBytes.set(getBase58Encoder().encode("SysvarC1ock11111111111111111111111111111111"), 76);
    view.setUint8(294, 1);
    view.setBigInt64(295, 100_000n, true);
    const base64 = btoa(String.fromCharCode(...headerBytes));

    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { id: number; method: string };
      if (body.method === "getMultipleAccounts") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: [{ data: [base64, "base64"], owner: "x", lamports: 1 }] } }));
      throw new Error(`unexpected method ${body.method}`);
    }) as unknown as typeof fetch;

    const deps = await buildOrchestratorDeps({ DB: db, SOLANA_RPC_URL: "https://l1.test" } as Env, fetcher, null, undefined);
    expect(deps).not.toBeNull();
    const orchestrator = new ProtocolKeeperOrchestrator(deps!);
    const summary = await orchestrator.run();
    expect(summary.leaseAcquired).toBe(true);
    const market = summary.results.find((r) => r.marketPda === marketPda);
    expect(market?.error).toBeUndefined();
    expect(market?.session?.ran).toBe(false);
    expect(market?.funding?.ran).toBe(false);
  });
});
