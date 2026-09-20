/** Pure safety guards for the resumable V3 commit runner. */
export function validateCheckpoint(checkpoint, mode, accounts) {
  if (!checkpoint || checkpoint.version !== 1 || !Number.isInteger(checkpoint.next) || checkpoint.next < 0 || checkpoint.next > accounts.length) {
    throw new Error("invalid V3 sharded checkpoint header");
  }
  if (!Array.isArray(checkpoint.events) || checkpoint.events.length !== checkpoint.next) {
    throw new Error("V3 sharded checkpoint event count does not match next index");
  }
  checkpoint.events.forEach((event, index) => {
    if (event.index !== index || event.child !== accounts[index].toBase58() || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new Error(`V3 sharded checkpoint mismatch at child ${index}`);
    }
  });
  if (checkpoint.complete && checkpoint.next !== accounts.length) throw new Error("complete V3 sharded checkpoint has unfinished children");
  if (checkpoint.mode && checkpoint.mode !== mode) throw new Error("V3 sharded checkpoint mode mismatch");
}

export function validateV3CoreBytes(coreBytes) {
  if (!coreBytes || coreBytes.length !== 4_096 || Buffer.from(coreBytes).subarray(0, 8).toString() !== "STKMK003" || coreBytes.readUInt16LE(8) !== 3) {
    throw new Error("resolved ER core is not a V3 MarketCore account");
  }
}
