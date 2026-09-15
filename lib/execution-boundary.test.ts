import { describe, expect, it } from "vitest";
import { executeL1, type L1Transport, type TransactionPreview, type WalletBoundary } from "./execution-boundary";

describe("transaction execution boundary", () => {
  it("simulates, signs, submits and confirms without inventing a signature", async () => {
    const calls: string[] = [];
    const wallet: WalletBoundary = { signTransaction: async (bytes) => { calls.push("sign"); return new Uint8Array([...bytes, 1]); } };
    const transport: L1Transport = { simulate: async () => { calls.push("simulate"); return { units: 100 }; }, submit: async (bytes) => { calls.push(`submit:${bytes.length}`); return { signature: "real-transport-result" }; }, confirm: async (signature) => { calls.push(`confirm:${signature}`); return "confirmed"; } };
    const preview: TransactionPreview = { instruction: "CreateTraderSeat", programId: "program", accounts: [], status: "constructed" };
    const result = await executeL1(preview, wallet, transport, Uint8Array.of(4));
    expect(result.signature).toBe("real-transport-result");
    expect(result.confirmation).toBe("confirmed");
    expect(calls).toEqual(["simulate", "sign", "submit:2", "confirm:real-transport-result"]);
  });
});
