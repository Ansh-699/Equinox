/** Keeps the L1 oracle snapshot fresh for writes via the market API's
 * permissionless refresh (the program needs a price under 10 seconds old).
 * `er()` additionally waits until MagicBlock serves that snapshot sequence. */
export interface OracleFreshness { l1(): Promise<void>; er(): Promise<void> }

/** Well inside the program's 10 s window, leaving room for devnet clock drift. */
export const ER_FAST_PATH_MAX_AGE_S = 4;
/** When a refresh fails, a price this recent still goes to the program's 10 s check. */
export const ER_FALLBACK_MAX_AGE_S = 8;

export function createOracleFreshness(options: {
  marketApiUrl: string;
  readErSequence: () => Promise<bigint | null>;
  /** The rollup's snapshot publish time (unix seconds): a recent one skips the refresh round trip. */
  readErPublishTime?: () => Promise<bigint | null>;
  now?: () => number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  erTimeoutMs?: number;
}): OracleFreshness {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const refresh = async (): Promise<bigint> => {
    const response = await fetcher(`${options.marketApiUrl.replace(/\/$/, "")}/v1/oracle/refresh`, { method: "POST" });
    const body = await response.json().catch(() => null) as { status?: string; sequence?: string; reason?: string } | null;
    if (!response.ok || !body?.sequence || (body.status !== "fresh" && body.status !== "refreshed")) {
      throw new Error(`Could not refresh the TSLA price: ${body?.reason ?? `HTTP ${response.status}`}`);
    }
    return BigInt(body.sequence);
  };
  return {
    l1: async () => { await refresh(); },
    er: async () => {
      // The market maker keeps the rollup's price a few seconds old at most; only
      // an order that would meet a stale price pays for the refresh.
      const published = await options.readErPublishTime?.().catch(() => null);
      const age = published == null ? null : (options.now ?? Date.now)() / 1000 - Number(published);
      if (age !== null && age <= ER_FAST_PATH_MAX_AGE_S) return;
      let sequence: bigint;
      try {
        sequence = await refresh();
      } catch (error) {
        // A refresh that lost a race still leaves a usable price: the program's
        // own 10 s check decides, so only give up when the price is truly old.
        if (age !== null && age <= ER_FALLBACK_MAX_AGE_S) return;
        throw error;
      }
      const attempts = Math.ceil((options.erTimeoutMs ?? 8_000) / 200);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const seen = await options.readErSequence().catch(() => null);
        if (seen !== null && seen >= sequence) return;
        await sleep(200);
      }
      throw new Error("MagicBlock has not received the fresh price yet; try again.");
    },
  };
}
