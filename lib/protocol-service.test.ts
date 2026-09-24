import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { EquinoxProtocolService } from "./protocol-service";

const key = new PublicKey(new Uint8Array(32));
const service = new EquinoxProtocolService({
  encode: async (instructions) => Uint8Array.from([instructions.length]),
  wallet: { signTransaction: async (bytes) => bytes },
  l1: { simulate: async () => ({ units: 1 }), submit: async () => ({ signature: "mock" }), confirm: async () => "confirmed" },
  er: { getAccountAwareBlockhash: async () => "router-blockhash", submit: async () => ({ status: "er_accepted", sequence: 1n }) },
});

describe("protocol service", () => {
  it("builds the seat/scratch transaction pair", () => {
    const instructions = service.buildSeatAndScratch({ market: key, authority: key, settlementScratch: key, seatIndex: 2 });
    expect(instructions).toHaveLength(2);
    expect(instructions[0].data[0]).toBe(1);
    expect(instructions[1].data[0]).toBe(8);
  });
});
