import { describe, expect, it } from "vitest";
import { decodeOracleSnapshot, readOracleSnapshot } from "./oracle-snapshot";

describe("OracleSnapshotV3", () => {
  it("decodes the authenticated fixed layout", () => {
    const bytes = new Uint8Array(128); bytes.set(new TextEncoder().encode("STKORS03"));
    const view = new DataView(bytes.buffer); view.setUint16(8, 3, true); bytes[10] = 1; view.setUint32(44, 1435, true); bytes[48] = 2; view.setInt32(49, -5, true); view.setBigInt64(53, 36982565n, true); bytes[87] = 1;
    expect(decodeOracleSnapshot(bytes)).toMatchObject({ feedId: 1435, channel: 2, exponent: -5, price: 36982565n, authenticated: true });
  });

  it("reads only the base64 account through the supplied transport", async () => {
    const bytes = new Uint8Array(128); bytes.set(new TextEncoder().encode("STKORS03"));
    const view = new DataView(bytes.buffer); view.setUint16(8, 3, true); bytes[10] = 1; view.setBigInt64(53, 1n, true); view.setBigUint64(61, 0n, true); view.setBigUint64(69, 1n, true); view.setBigUint64(77, 1n, true); bytes[86] = 0; bytes[87] = 1; bytes[88] = 1;
    const encoded = btoa(String.fromCharCode(...bytes));
    const result = await readOracleSnapshot({ account: async () => ({ context: { slot: 7 }, value: { data: [encoded, "base64"] } }) }, "snapshot");
    expect(result?.slot).toBe(7); expect(result?.snapshot.authenticated).toBe(true);
  });
});
