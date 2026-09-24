/** Pure readiness checks. Callers supply freshly read, identity-validated L1 bytes. */
export const V3_LIFECYCLE_ORDER = Object.freeze([
  "exchange-and-instrument", "oracle-metadata", "core-activation",
  "fresh-pyth-update", "trader-seat", "l1-session-allocation", "l1-test-collateral", "collateral-readback",
  "er-delegation", "session-member-delegation", "limited-session", "er-orders-and-fills",
]);

/** An authenticated, fresh, open TSLA `OracleSnapshotV3` (the ER price source). */
/** The snapshot must carry the core's own feed (Pyth, or a reporter-priced market's reserved id). */
function snapshotFresh(snapshot, nowSeconds, core) {
  if (snapshot?.length !== 128 || snapshot.subarray(0, 8).toString() !== "STKORS03" || snapshot[87] !== 1
    || snapshot.readUInt32LE(44) !== core.readUInt32LE(246) || snapshot[48] !== core[250] || snapshot.readInt32LE(49) !== core.readInt32LE(251)
    || snapshot[86] !== 0 || snapshot.readBigUInt64LE(77) === 0n) return false;
  const price = snapshot.readBigInt64LE(53); const published = Number(snapshot.readBigUInt64LE(69));
  return price > 0n && snapshot.readBigUInt64LE(61) <= price / 5n
    && nowSeconds <= published + 10 && published <= nowSeconds + 2;
}

export function assertV3L1Readiness({ core, seatShards, accountCount, nowSeconds, requireCollateral = true, snapshot }) {
  if (accountCount !== 27 || core?.length !== 4096 || seatShards?.length !== 4
    || seatShards.some(bytes => bytes?.length !== 8236)) throw new Error("incomplete execution bundle");
  if (core.subarray(0, 8).toString() !== "STKMK003" || core.readUInt16LE(8) !== 3
    || core[10] !== 1 || core[371] !== 2) throw new Error("revision-2 active core required");
  if ([1, 2].includes(core[197])) throw new Error("L1 deposit must precede delegation");
  const published = Number(core.readBigUInt64LE(189));
  const coreOracleFresh = core[180] === 1 && core[1686] <= 2
    && nowSeconds <= published + 10 && published <= nowSeconds + 2
    && core.readBigInt64LE(181) > 0n && core.readBigUInt64LE(1687) <= core.readBigInt64LE(181) / 5n;
  if (!Number.isSafeInteger(nowSeconds) || core[11] !== 1
    || !(snapshot ? snapshotFresh(snapshot, nowSeconds, core) : coreOracleFresh)) throw new Error("oracle stale or unavailable");
  if (core.readUInt32LE(246) === 0 || core[250] === 0 || core.readInt32LE(251) !== -5)
    throw new Error("oracle metadata missing");
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
