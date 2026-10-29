import { describe, expect, it } from "vitest";
import { DBC_PROGRAM_ID, listLaunches, parseLaunch, registerLaunch } from "./launches";

describe("launch registration", () => {
  const pool = "GqayPPdhNk87efBTnTNJQPKem6mWsSBtoWjgY6KGdmFk", baseMint = "6CCai5f9yHvBNkdx1BsANk1fmxjDxZRaRjHS6Df8XyH1";
  it("accepts a well-formed launch and normalizes the symbol", () => {
    expect(parseLaunch({ pool, baseMint, symbol: "smoke", name: " Smoke Equity ", preset: "devnet" }, 5)).toEqual({ pool, baseMint, symbol: "SMOKE", name: "Smoke Equity", preset: "devnet", network: "devnet", createdAt: 5 });
  });
  it("keeps mainnet launches apart and checks them against mainnet", async () => {
    expect(parseLaunch({ pool, baseMint, symbol: "TSLAB", name: "x", network: "mainnet" }, 5)).toHaveProperty("network", "mainnet");
    expect(parseLaunch({ pool, baseMint, symbol: "TSLAB", name: "x", network: "testnet" }, 5)).toHaveProperty("network", "devnet");
    const bound: unknown[][] = [];
    const db = { prepare: () => ({ bind: (...values: unknown[]) => { bound.push(values); return { run: async () => undefined }; } }) } as unknown as D1Database;
    const asked: string[] = [];
    // Only the mainnet RPC knows this pool.
    const rpcFor = (network: string) => ({ call: async <T>() => { asked.push(network); return { value: network === "mainnet" ? { owner: DBC_PROGRAM_ID } : null } as T; } });
    expect((await registerLaunch(db, rpcFor, { pool, baseMint, symbol: "TSLAB", name: "x", network: "mainnet" }, 5)).status).toBe(200);
    expect((await registerLaunch(db, rpcFor, { pool, baseMint, symbol: "TSLAB", name: "x" }, 5)).status).toBe(400);
    expect(asked).toEqual(["mainnet", "devnet"]);
    expect(bound).toEqual([[pool, baseMint, "TSLAB", "x", "", "mainnet", 5]]);
    const listed = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ all: async () => ({ results: [{ sql, values }] }) }) }) } as unknown as D1Database;
    expect(await listLaunches(listed, "mainnet")).toEqual([{ sql: expect.stringContaining("WHERE network = ?"), values: ["mainnet"] }]);
  });
  it("refuses anything that is not two addresses and a short symbol", () => {
    expect(parseLaunch({ pool: "nope", baseMint, symbol: "SMOKE", name: "x" }, 5)).toHaveProperty("error");
    expect(parseLaunch({ pool, baseMint, symbol: "WAYTOOLONGSYMBOL", name: "x" }, 5)).toHaveProperty("error");
    expect(parseLaunch(null, 5)).toHaveProperty("error");
  });
});
