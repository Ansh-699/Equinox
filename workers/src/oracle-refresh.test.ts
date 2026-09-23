import { expect, test } from "vitest";
import { refreshOracleSnapshot, type RefreshDeps, type RefreshMarket } from "./oracle-refresh";
import { decodeTransaction } from "./transactions";
import { LocalKeypairSigner } from "./signer";

const market: RefreshMarket = {
  programId: "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ",
  core: "9Vea9MVZCzYFKNHaHMPET9fuXXjfof8mA2F75pbBDJyV",
  snapshot: "7g5Wz9NfxRzNJbQPvFFf8b8yf8JjRB6W4LnzwxzPi8JE",
  feedId: 1435, channel: "fixed_rate@50ms",
};
const NOW = 1_790_000_000;

function snapshotBytes(publishTime: number, sequence: bigint): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set(new TextEncoder().encode("STKORS03"));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 3, true); bytes[10] = 1; bytes[87] = 1; bytes[88] = 1;
  view.setUint32(44, 1435, true); bytes[48] = 2; view.setInt32(49, -5, true);
  view.setBigInt64(53, 37_900_000n, true); view.setBigUint64(69, BigInt(publishTime), true); view.setBigUint64(77, sequence, true);
  return bytes;
}
function signedMessage(): Uint8Array {
  const message = new Uint8Array(102 + 40);
  new DataView(message.buffer).setUint16(100, 40, true);
  return message;
}

function deps(overrides: Partial<RefreshDeps> & { snapshots: Uint8Array[] }): RefreshDeps & { sent: string[] } {
  const sent: string[] = [];
  const storage = new Uint8Array(72).fill(3);
  let read = 0;
  return {
    sent,
    now: () => NOW * 1000,
    readAccount: async (address) => address === market.snapshot ? overrides.snapshots[Math.min(read++, overrides.snapshots.length - 1)] : storage,
    fetchSignedMessage: async () => signedMessage(),
    signer: new LocalKeypairSigner("test", JSON.stringify([...crypto.getRandomValues(new Uint8Array(32)), ...new Uint8Array(32)])),
    latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n }),
    send: async (tx) => { sent.push(tx); return "sig"; },
    confirm: async () => "confirmed",
    ...overrides,
  };
}

test("a snapshot younger than the freshness window is reused without a transaction", async () => {
  const d = deps({ snapshots: [snapshotBytes(NOW - 1, 5n)] });
  expect(await refreshOracleSnapshot(market, d)).toMatchObject({ status: "fresh", sequence: "5" });
  expect(d.sent).toHaveLength(0);
});

test("a stale snapshot is refreshed with Ed25519 at index 0 and the update at index 1", async () => {
  const d = deps({ snapshots: [snapshotBytes(NOW - 30, 5n), snapshotBytes(NOW, 6n)] });
  expect(await refreshOracleSnapshot(market, d)).toMatchObject({ status: "refreshed", sequence: "6", signature: "sig" });
  const tx = decodeTransaction(d.sent[0]);
  const { getCompiledTransactionMessageDecoder } = await import("@solana/kit");
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const programs = message.instructions.map((ix) => message.staticAccounts[ix.programAddressIndex]);
  expect(programs).toEqual(["Ed25519SigVerify111111111111111111111111111", market.programId]);
  const update = message.instructions[1].data!;
  expect(update[0]).toBe(58);
  expect(new DataView(update.buffer, update.byteOffset).getUint16(1, true)).toBe(0);
  expect(message.staticAccounts[message.instructions[1].accountIndices![0]]).toBe(market.snapshot);
});

test("losing a concurrent refresh race still reports a fresh snapshot", async () => {
  const d = deps({ snapshots: [snapshotBytes(NOW - 30, 5n), snapshotBytes(NOW, 6n)], send: async () => { throw new Error("replay"); } });
  expect(await refreshOracleSnapshot(market, d)).toMatchObject({ status: "fresh", sequence: "6" });
});

test("a failed send with a still-stale snapshot is reported, not hidden", async () => {
  const d = deps({ snapshots: [snapshotBytes(NOW - 30, 5n)], send: async () => { throw new Error("insufficient funds"); } });
  expect(await refreshOracleSnapshot(market, d)).toMatchObject({ status: "failed", reason: "insufficient funds", payer: expect.any(String) });
});
