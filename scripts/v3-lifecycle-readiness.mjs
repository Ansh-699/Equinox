/** Pure readiness checks. Callers supply freshly read, identity-validated L1 bytes. */
export const V3_LIFECYCLE_ORDER = Object.freeze([
  "exchange-and-instrument", "oracle-metadata", "core-activation",
  "fresh-pyth-update", "trader-seat", "l1-test-collateral", "collateral-readback",
  "er-delegation", "limited-session", "er-orders-and-fills",
]);

export function assertV3L1Readiness({ core, seatShards, accountCount, nowSeconds, requireCollateral = true }) {
  if (accountCount !== 27 || core?.length !== 4096 || seatShards?.length !== 4
    || seatShards.some(bytes => bytes?.length !== 8236)) throw new Error("incomplete execution bundle");
  if (core.subarray(0, 8).toString() !== "STKMK003" || core.readUInt16LE(8) !== 3
    || core[10] !== 1 || core[371] !== 2) throw new Error("revision-2 active core required");
  if ([1, 2].includes(core[197])) throw new Error("L1 deposit must precede delegation");
  const published = Number(core.readBigUInt64LE(189));
  if (!Number.isSafeInteger(nowSeconds) || core[180] !== 1 || core[11] !== 1
    || core[1686] > 2 || nowSeconds > published + 10 || published > nowSeconds + 2
    || core.readBigInt64LE(181) <= 0n
    || core.readBigUInt64LE(1687) > core.readBigInt64LE(181) / 5n) throw new Error("oracle stale or unavailable");
  if (core.readUInt32LE(246) !== 1435 || core[250] !== 2 || core.readInt32LE(251) !== -5)
    throw new Error("TSLA oracle metadata mismatch");
  let seats = 0; let funded = 0;
  for (const bytes of seatShards) {
    for (let slot = 0; slot < 32; slot++) {
      const at = 44 + slot * 256;
      if (bytes[at] !== 1) continue;
      seats++;
      const collateral = bytes.readBigUInt64LE(at + 40) + (bytes.readBigInt64LE(at + 48) << 64n);
      if (collateral > 0n) funded++;
    }
  }
  if (!seats) throw new Error("trader seat missing");
  if (requireCollateral && !funded) throw new Error("test collateral missing");
  return { seats, funded, custodyDomain: "l1", executionDomain: "er" };
}
