import { describe, expect, it } from "vitest";
import { checkedSigned, checkedUnsigned, writeSigned, writeUnsigned } from "./encoding";

describe("canonical ABI integer encoding", () => {
  it("writes unsigned and signed values in little-endian form", () => {
    const bytes = new Uint8Array(8);
    writeUnsigned(bytes, 0, 0x1234n, 2);
    writeSigned(bytes, 2, -2n, 2);
    expect([...bytes.slice(0, 4)]).toEqual([0x34, 0x12, 0xfe, 0xff]);
  });

  it("rejects values outside their declared ABI ranges", () => {
    expect(checkedUnsigned(255, 8, "x")).toBe(255n);
    expect(checkedSigned(-128, 8, "x")).toBe(-128n);
    expect(() => checkedUnsigned(256, 8, "x")).toThrow("outside u8");
    expect(() => checkedSigned(128, 8, "x")).toThrow("outside i8");
  });
});
