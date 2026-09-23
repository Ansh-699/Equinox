/** V3 markets hold 128 seats (4 shards × 32). */
export const V3_SEAT_COUNT = 128;

/** A wallet's seat: the one it already occupies, else the first free slot
 * (null when the market is full). Positions come from the V3 aggregate. */
export function resolveV3Seat(positions: readonly { shard: number; slot: number; trader: string }[], wallet: string): { seatIndex: number; existing: boolean } | null {
  const own = positions.find((position) => position.trader === wallet);
  if (own) return { seatIndex: own.shard * 32 + own.slot, existing: true };
  const occupied = new Set(positions.map((position) => position.shard * 32 + position.slot));
  for (let seatIndex = 0; seatIndex < V3_SEAT_COUNT; seatIndex += 1) if (!occupied.has(seatIndex)) return { seatIndex, existing: false };
  return null;
}
