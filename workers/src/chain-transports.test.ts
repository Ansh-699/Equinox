import { describe, expect, it, vi } from "vitest";
import {
  classifyRpcError,
  classifyWritableAccountDomain,
  JsonRpcTransport,
  MagicBlockErTransport,
  MagicRouterTransport,
  SolanaL1Transport,
  withRetry,
} from "./chain-transports";

/** A real mock HTTP server for the JSON-RPC transport: parses the actual
 * request body Equinox's transports send and returns the real
 * `{jsonrpc, id, result}` (or `error`) envelope shape a Solana RPC node
 * would, keyed by method name -- not a stubbed transport interface. */
function mockRpcServer(handlers: Record<string, (params: unknown[]) => unknown>): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
    expect(body.jsonrpc).toBe("2.0");
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC method ${body.method}`);
    const result = handler(body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("JsonRpcTransport", () => {
  it("rejects a non-http(s) endpoint", () => {
    expect(() => new JsonRpcTransport("ftp://bad")).toThrow(/Invalid RPC endpoint/);
  });

  it("surfaces a real JSON-RPC error envelope with its code", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }), {
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const transport = new JsonRpcTransport("https://rpc.test", fetcher);
    await expect(transport.call("getFoo", [])).rejects.toThrow(/-32602.*invalid params/);
  });

  it("surfaces a non-2xx HTTP status", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const transport = new JsonRpcTransport("https://rpc.test", fetcher);
    await expect(transport.call("getFoo", [])).rejects.toThrow(/RPC HTTP 503/);
  });
});

describe("SolanaL1Transport write path", () => {
  it("fetches a real getLatestBlockhash response shape", async () => {
    const fetcher = mockRpcServer({
      getLatestBlockhash: () => ({ context: { slot: 100 }, value: { blockhash: "abc", lastValidBlockHeight: 1000 } }),
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const result = await l1.latestBlockhash("confirmed");
    expect(result.value.blockhash).toBe("abc");
    expect(result.value.lastValidBlockHeight).toBe(1000);
  });

  it("fetches getMultipleAccounts for several addresses in one request", async () => {
    const fetcher = mockRpcServer({
      getMultipleAccounts: (params) => {
        expect(params[0]).toEqual(["addr-a", "addr-b"]);
        return { context: { slot: 1 }, value: [{ data: ["", "base64"], owner: "prog", lamports: 1 }, null] };
      },
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const result = await l1.multipleAccounts(["addr-a", "addr-b"]);
    expect(result.value).toHaveLength(2);
    expect(result.value[1]).toBeNull();
  });

  it("simulates and sends a transaction", async () => {
    const fetcher = mockRpcServer({
      simulateTransaction: () => ({ context: { slot: 1 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 500 } }),
      sendTransaction: () => "sig1",
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const sim = await l1.simulateTransaction("base64tx");
    expect(sim.value.err).toBeNull();
    expect(sim.value.unitsConsumed).toBe(500);
    expect(await l1.sendTransaction("base64tx")).toBe("sig1");
  });

  it("confirmTransaction resolves 'confirmed' then distinguishes it from 'finalized'", async () => {
    const fetcher = mockRpcServer({
      getSignatureStatuses: () => ({ context: { slot: 5 }, value: [{ slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }),
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const outcome = await l1.confirmTransaction("sig1", { targetCommitment: "confirmed", lastValidBlockHeight: 1000, sleep: async () => {} });
    expect(outcome).toEqual({ status: "confirmed" });
  });

  it("confirmTransaction keeps polling past 'confirmed' until 'finalized' when that's the target", async () => {
    let calls = 0;
    const fetcher = mockRpcServer({
      getSignatureStatuses: () => {
        calls += 1;
        const confirmationStatus = calls < 2 ? "confirmed" : "finalized";
        return { context: { slot: 5 }, value: [{ slot: 5, confirmations: calls, err: null, confirmationStatus }] };
      },
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const outcome = await l1.confirmTransaction("sig1", { targetCommitment: "finalized", lastValidBlockHeight: 1000, sleep: async () => {} });
    expect(outcome).toEqual({ status: "finalized" });
    expect(calls).toBe(2);
  });

  it("confirmTransaction reports a failed transaction's on-chain error", async () => {
    const fetcher = mockRpcServer({
      getSignatureStatuses: () => ({ context: { slot: 5 }, value: [{ slot: 5, confirmations: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }] }),
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const outcome = await l1.confirmTransaction("sig1", { targetCommitment: "confirmed", lastValidBlockHeight: 1000, sleep: async () => {} });
    expect(outcome).toEqual({ status: "failed", err: { InstructionError: [0, "Custom"] } });
  });

  it("confirmTransaction detects blockhash expiry once the network's block height passes lastValidBlockHeight", async () => {
    const fetcher = mockRpcServer({
      getSignatureStatuses: () => ({ context: { slot: 5 }, value: [null] }),
      getBlockHeight: () => 2000,
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    const outcome = await l1.confirmTransaction("sig1", { targetCommitment: "confirmed", lastValidBlockHeight: 1000, sleep: async () => {} });
    expect(outcome).toEqual({ status: "blockhash_expired" });
  });

  it("confirmTransaction times out if the deadline passes with no resolution", async () => {
    const fetcher = mockRpcServer({
      getSignatureStatuses: () => ({ context: { slot: 5 }, value: [null] }),
      getBlockHeight: () => 500,
    });
    const l1 = new SolanaL1Transport("https://l1.test", fetcher);
    let now = 0;
    const outcome = await l1.confirmTransaction("sig1", {
      targetCommitment: "confirmed",
      lastValidBlockHeight: 1000,
      timeoutMs: 10,
      pollIntervalMs: 5,
      now: () => now,
      sleep: async () => {
        now += 20;
      },
    });
    expect(outcome).toEqual({ status: "timeout" });
  });
});

describe("classifyRpcError", () => {
  it.each([
    ["blockhash not found", "retryable"],
    ["429 Too Many Requests", "retryable"],
    ["RPC HTTP 503", "retryable"],
    ["fetch failed", "retryable"],
    ["insufficient funds for rent", "permanent"],
    ["InstructionError: custom program error: 0x1", "permanent"],
    ["RPC HTTP 400", "permanent"],
    ["some totally novel error", "unknown"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyRpcError(new Error(message))).toBe(expected);
  });
});

describe("withRetry", () => {
  it("retries a retryable failure and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("blockhash not found");
      return "ok";
    }, 5);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts += 1;
        throw new Error("insufficient funds");
      }, 5),
    ).rejects.toThrow(/insufficient funds/);
    expect(attempts).toBe(1);
  });

  it("stops retrying once maxAttempts is exhausted", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts += 1;
        throw new Error("blockhash not found");
      }, 2),
    ).rejects.toThrow(/blockhash not found/);
    expect(attempts).toBe(2);
  });
});

describe("classifyWritableAccountDomain", () => {
  function marketBytes(delegationStatus: number): Uint8Array {
    const bytes = new Uint8Array(400);
    bytes[329] = delegationStatus;
    return bytes;
  }

  it("routes a Delegated market's writes to the ER", () => {
    expect(classifyWritableAccountDomain(marketBytes(1))).toBe("er");
  });

  it("routes an Undelegating market's writes to the ER (still ER-authoritative until the callback lands)", () => {
    expect(classifyWritableAccountDomain(marketBytes(2))).toBe("er");
  });

  it("routes a NotDelegated or Restored market's writes to L1", () => {
    expect(classifyWritableAccountDomain(marketBytes(0))).toBe("l1");
    expect(classifyWritableAccountDomain(marketBytes(3))).toBe("l1");
  });

  it("defaults to L1 for an account too short to carry a delegation byte", () => {
    expect(classifyWritableAccountDomain(new Uint8Array(10))).toBe("l1");
  });
});

describe("MagicRouterTransport", () => {
  it("is exported under its historical name for existing callers", () => {
    expect(MagicBlockErTransport).toBe(MagicRouterTransport);
  });

  it("shares the same write-path methods as SolanaL1Transport (Solana-RPC-compatible ER validator)", async () => {
    const fetcher = mockRpcServer({
      getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: "er-hash", lastValidBlockHeight: 50 } }),
      sendTransaction: () => "er-sig",
    });
    const router = new MagicRouterTransport("https://router.test", fetcher);
    expect((await router.latestBlockhash()).value.blockhash).toBe("er-hash");
    expect(await router.sendTransaction("base64tx")).toBe("er-sig");
  });
});
