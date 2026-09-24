/** The terminal's own rollup transactions (submit → confirmed), for the latency panel. */
/** `ms`: send → rollup "processed" push; `netMs`: the plain network round trip to the rollup at that time. */
export interface ErTxSample { market?: string; kind: string; ms: number | null; /** Send → included in a produced rollup block (bot rows). */ blockMs?: number | null; netMs?: number | null; ok: boolean; at: number; signature: string; side?: "bid" | "ask"; price?: number; quantity?: number; mine?: boolean }

let samples: readonly ErTxSample[] = [];
const listeners = new Set<() => void>();

export function recordErTx(sample: ErTxSample) {
  samples = [{ ...sample, mine: true }, ...samples].slice(0, 30); // a new array: useSyncExternalStore compares by reference
  listeners.forEach((listener) => listener());
}

export function myErTxs(): readonly ErTxSample[] { return samples; }

export function onErTx(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
