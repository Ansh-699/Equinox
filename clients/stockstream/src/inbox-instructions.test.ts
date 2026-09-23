import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { claimInboxDepositV3, depositToInboxV3, deriveDepositReceiptV3, deriveV3ExecutionAccounts, requestWithdrawalV3, claimWithdrawalV3, deriveWithdrawReceiptV3 } from "./index";

describe("deposit inbox encoders", () => {
  const core = Keypair.generate().publicKey.toBase58();
  const trader = Keypair.generate().publicKey.toBase58();
  const receipt = deriveDepositReceiptV3(core, trader).toBase58();

  it("DepositToInboxV3: [60, amount u64], receipt writable, trader signs", () => {
    const ix = depositToInboxV3({ core, trader, source: trader, vault: core, mint: core, tokenProgram: core }, 1_000_000n);
    expect([...ix.data]).toEqual([60, 64, 66, 15, 0, 0, 0, 0, 0]);
    expect(ix.keys[1]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[1].pubkey.toBase58()).toBe(receipt);
    expect(ix.keys[2]).toMatchObject({ isWritable: true, isSigner: true });
    expect(ix.keys[7].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it("ClaimInboxDepositV3: [61, seat u16], permissionless, receipt read-only", () => {
    const accounts = deriveV3ExecutionAccounts(core, trader);
    const ix = claimInboxDepositV3({ core, seatShard: accounts.seatShards[1], eventShards: accounts.eventShards, trader }, 33);
    expect([...ix.data]).toEqual([61, 33, 0]);
    expect(ix.keys).toHaveLength(7);
    expect(ix.keys.some((key) => key.isSigner)).toBe(false);
    expect(ix.keys[6]).toMatchObject({ isWritable: false });
    expect(ix.keys[6].pubkey.toBase58()).toBe(receipt);
  });
});

describe("V3 withdrawal outbox encoders", () => {
  const core = Keypair.generate().publicKey, trader = Keypair.generate().publicKey;
  const events = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
  it("request carries seat+amount and the magic accounts in program order", () => {
    const ix = requestWithdrawalV3({ core, seatShard: core, eventShards: events, trader, oracleSnapshot: core }, 5, 1_000_000n);
    expect(ix.data[0]).toBe(62);
    expect(ix.data.length).toBe(11);
    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[6]).toMatchObject({ isSigner: true });
    expect(ix.keys[7].pubkey.toBase58()).toBe("MagicContext1111111111111111111111111111111");
  });
  it("claim uses the derived payout receipt", () => {
    const ix = claimWithdrawalV3({ core, seatShard: core, trader, destination: core, vault: core, vaultAuthority: core, mint: core, tokenProgram: core }, 5);
    expect([...ix.data]).toEqual([63, 5, 0]);
    expect(ix.keys[8].pubkey.equals(deriveWithdrawReceiptV3(core, trader))).toBe(true);
  });
});
