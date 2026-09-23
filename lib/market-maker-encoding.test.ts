import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { cancelAllV3, cancelOrderV3, deriveV3ExecutionAccounts, placeOrderV3, replaceOrderV3 } from "@/clients/stockstream/src";
import { cancelAllIx, cancelOrderIx, ladder, planQuotes, placeOrderIx, replaceOrderIx, type RestingOrder } from "../workers/src/mm-encoding";

// The Worker market maker encodes orders without web3.js; they must stay
// byte-identical to the shared client encoders the terminal and scripts use.
describe("market-maker order encoding", () => {
  const core = Keypair.generate().publicKey.toBase58();
  const authority = Keypair.generate().publicKey.toBase58();
  const snapshot = Keypair.generate().publicKey.toBase58();
  const derived = deriveV3ExecutionAccounts(core, authority);
  const bundle = { core, bookPages: derived.bookPages.map(String), seatShards: derived.seatShards.map(String), eventShards: derived.eventShards.map(String), oracleSnapshot: snapshot };
  const roles = (ix: { keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map((k) => [k.pubkey.toBase58(), (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0)]);

  it("PlaceOrderV3 matches the client encoder", () => {
    const order = { seatIndex: 3, side: "ask" as const, quantity: 7n, price: 38_012_345n, expiresAt: 1_800_000_000n, clientOrderId: 42n, postOnly: true };
    const client = placeOrderV3({ ...derived, authority, oracleSnapshot: snapshot, seatIndex: 3, side: "ask", quantity: 7n, priceOrOffset: 38_012_345n, expiresAt: 1_800_000_000n, clientOrderId: 42n, postOnly: true });
    const kit = placeOrderIx(bundle, authority, order);
    expect([...(kit.data ?? [])]).toEqual([...client.data]);
    expect(kit.accounts?.map((a) => [a.address, a.role])).toEqual(roles(client));
  });

  it("CancelAllV3 matches the client encoder", () => {
    const client = cancelAllV3({ ...derived, authority, oracleSnapshot: snapshot }, 3, 32);
    const kit = cancelAllIx(bundle, authority, 3, 32);
    expect([...(kit.data ?? [])]).toEqual([...client.data]);
    expect(kit.accounts?.map((a) => [a.address, a.role])).toEqual(roles(client));
  });

  const key = (0x0246dffa0n << 64n) | 0x2edan;
  it("ReplaceOrderV3 matches the client encoder", () => {
    const client = replaceOrderV3({ ...derived, authority, oracleSnapshot: snapshot, oldOrderKey: key, seatIndex: 3, side: "bid", quantity: 5n, priceOrOffset: 38_000_000n, expiresAt: 1_800_000_000n, clientOrderId: 9n, postOnly: true });
    const kit = replaceOrderIx(bundle, authority, key, { seatIndex: 3, side: "bid", quantity: 5n, price: 38_000_000n, expiresAt: 1_800_000_000n, clientOrderId: 9n, postOnly: true });
    expect([...(kit.data ?? [])]).toEqual([...client.data]);
    expect(kit.accounts?.map((a) => [a.address, a.role])).toEqual(roles(client));
  });

  it("CancelOrderV3 matches the client encoder", () => {
    const client = cancelOrderV3({ ...derived, authority, oracleSnapshot: snapshot }, 3, key);
    expect([...(cancelOrderIx(bundle, authority, 3, key).data ?? [])]).toEqual([...client.data]);
  });
});

describe("incremental quote planning", () => {
  const index = 38_000_000n, now = 1_000n;
  const fixed = () => 0.5;
  const asResting = (quotes: ReturnType<typeof ladder>, shift = 0n): RestingOrder[] =>
    quotes.map((q, i) => ({ key: BigInt(i + 1), side: q.side, price: q.price + shift, quantity: q.quantity, expiresAt: now + 60n }));

  it("a fresh book places every rung, a matching book does nothing", () => {
    const targets = ladder(index, 0n, fixed);
    expect(planQuotes([], targets, index, now).every((a) => a.kind === "place")).toBe(true);
    expect(planQuotes(asResting(targets), targets, index, now)).toEqual([]);
  });

  it("a small move only replaces the touch, never wipes the book", () => {
    const targets = ladder(index, 0n, fixed);
    const actions = planQuotes(asResting(targets), ladder(index + 3_000n, 0n, fixed), index, now); // ≈0.8 bp
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThan(targets.length);
    expect(actions.every((a) => a.kind === "replace")).toBe(true);
  });

  it("replaces orders about to expire and cancels extras and expired ones", () => {
    const targets = ladder(index, 0n, fixed);
    const resting = asResting(targets);
    resting[0].expiresAt = now + 5n;
    resting.push({ key: 99n, side: "bid", price: 1n, quantity: 1n, expiresAt: now + 60n }, { key: 100n, side: "ask", price: 1n, quantity: 1n, expiresAt: now - 1n });
    const actions = planQuotes(resting, targets, index, now);
    expect(actions).toContainEqual(expect.objectContaining({ kind: "replace", key: 1n }));
    expect(actions).toContainEqual({ kind: "cancel", key: 99n });
    expect(actions).toContainEqual({ kind: "cancel", key: 100n });
  });
});
