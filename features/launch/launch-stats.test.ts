import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { holderStats } from "./launch-stats";

describe("holderStats", () => {
  it("counts wallets, skips PDA vaults and empty accounts, and sizes top-10 and dev shares", () => {
    const dev = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey("11111111111111111111111111111111"));
    const stats = holderStats([
      { owner: vault, amount: 800_000_000_000_000n }, // the curve's vault: not a holder
      { owner: dev, amount: 10_000_000_000_000n }, // 1% of 1B tokens
      { owner: other, amount: 5_000_000_000_000n },
      { owner: other, amount: 5_000_000_000_000n }, // same wallet, second account
      { owner: Keypair.generate().publicKey, amount: 0n },
    ], dev.toBase58());
    expect(stats.holders).toBe(2);
    expect(stats.devPct).toBeCloseTo(1);
    expect(stats.top10Pct).toBeCloseTo(2);
  });
});
