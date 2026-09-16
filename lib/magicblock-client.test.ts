import { describe, expect, it } from "vitest";
import { DELEGATION_PROGRAM } from "./magicblock";
import { assertOfficialDelegationProgram, buildCommitAndUndelegateCluster, buildCommitCluster, buildDelegateCluster } from "./magicblock-client";

const payer = "11111111111111111111111111111111";
const ownerProgram = "6QyZWQ7dvFNXerNdhzhyqQjzZnkMXmr52GNJLT1KpmU";
const validator = "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57";
const hot = [{ address: "SysvarC1ock11111111111111111111111111111111", domain: "er" as const, writable: true }];

describe("MagicBlock SDK execution instructions", () => {
  it("uses the official delegate constructor and encodes a thirty-second interval", async () => {
    const [instruction] = await buildDelegateCluster({ payer, ownerProgram, validator, hotAccounts: hot });
    assertOfficialDelegationProgram(instruction);
    expect(instruction.programAddress).toBe(DELEGATION_PROGRAM);
    expect(instruction.data).toBeDefined();
    const data = instruction.data!;
    expect(new DataView(data.buffer, data.byteOffset).getUint32(8, true)).toBe(30_000);
    expect(instruction.accounts).toHaveLength(7);
  });

  it("uses Magic Program commit and commit-and-undelegate constructors", () => {
    expect(buildCommitCluster(payer, hot).data).toEqual(Uint8Array.of(1, 0, 0, 0));
    expect(buildCommitAndUndelegateCluster(payer, hot).data).toEqual(Uint8Array.of(2, 0, 0, 0));
  });

  it("rejects mixed writable execution domains before constructing a route", () => {
    expect(() => buildCommitCluster(payer, [...hot, { address: payer, domain: "l1", writable: true }])).toThrow(/mixed/);
  });
});
