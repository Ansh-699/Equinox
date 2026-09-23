import { describe, expect, it } from "vitest";
import { buildV3OrderInstructions, GTC_SECONDS, usdToRawPrice } from "./v3-order";

const base = {
  core: "9Vea9MVZCzYFKNHaHMPET9fuXXjfof8mA2F75pbBDJyV", wallet: "A5sV4PkkVM4gm3rejACvKFgxEMmj8ouGsffSKT5qYVc8",
  oracleSnapshot: "7g5Wz9NfxRzNJbQPvFFf8b8yf8JjRB6W4LnzwxzPi8JE", seatIndex: 1, side: "bid" as const, orderType: "limit",
  reduceOnly: false, quantity: 10n, limitPriceUsd: "379.5", expiresInMinutes: 0, oracleClock: 1_000n,
};

describe("V3 order construction", () => {
  it("converts USD to the oracle's raw scale", () => {
    expect(usdToRawPrice("379.5")).toBe(37_950_000n);
    expect(usdToRawPrice("0")).toBeNull();
    expect(usdToRawPrice("abc")).toBeNull();
  });
  it("raises the compute limit, carries the snapshot and never sends a zero expiry", () => {
    const built = buildV3OrderInstructions(base);
    if ("error" in built) throw new Error(built.error);
    expect(built.instructions).toHaveLength(2);
    const order = built.instructions[1];
    expect(order.keys.at(-1)?.pubkey.toBase58()).toBe(base.oracleSnapshot);
    expect(order.keys.at(-1)?.isWritable).toBe(false);
    const expiry = Buffer.from(order.data).readBigUInt64LE(1 + 21);
    expect(expiry).toBe(1_000n + BigInt(GTC_SECONDS));
    expect(built.writableAccounts).toHaveLength(27);
  });
  it("rejects empty sizes and prices with plain messages", () => {
    expect(buildV3OrderInstructions({ ...base, quantity: 0n })).toEqual({ error: "Enter a size above zero." });
    expect(buildV3OrderInstructions({ ...base, limitPriceUsd: "" })).toEqual({ error: "Enter a limit price in USD." });
  });
});
