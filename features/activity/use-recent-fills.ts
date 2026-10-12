"use client";

import { useEffect, useState } from "react";
import { deriveV3ExecutionAccounts } from "@/clients/equinox/src";
import deployment from "@/config/equinox-deployment.json";
import { V3_MARKETS } from "@/lib/v3-markets";
import { decodeAccount, tradesFrom, type Trade } from "@/features/trading/use-v3-book";
import { decodeV3EventShard } from "../../workers/src/v3-market-state";

export interface Fill extends Trade { market: string }

const POLL_MS = 4_000;
// Every market's 4 event shards, read together from the rollup (16 accounts, zstd).
const SHARDS = V3_MARKETS.map((m) => ({ symbol: m.symbol, keys: deriveV3ExecutionAccounts(m.core, m.core).eventShards.map(String) }));
const KEYS = SHARDS.flatMap((s) => s.keys);

/** Recent fills in every market, decoded from the markets' event shards in the
 * MagicBlock rollup (the program's own fill records), newest first. */
export function useRecentFills(enabled = true): { fills: Fill[]; status: "loading" | "live" | "unavailable" } {
  const [state, setState] = useState<{ fills: Fill[]; status: "loading" | "live" | "unavailable" }>({ fills: [], status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const read = async () => {
      if (document.hidden) return;
      const body = await fetch(deployment.magicBlock.rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [KEYS, { encoding: "base64+zstd", commitment: "processed" }] }),
      }).then((r) => r.json()).catch(() => null) as { result?: { value: ({ data: [string, string] } | null)[] } } | null;
      if (stopped) return;
      const values = body?.result?.value;
      if (!values || values.length !== KEYS.length) { setState((s) => ({ ...s, status: "unavailable" })); return; }
      let fills: Fill[];
      try {
        fills = SHARDS.flatMap((market, m) => {
          const shards = market.keys.map((_, i) => {
            const value = values[m * 4 + i];
            return { records: value ? decodeV3EventShard(decodeAccount(value.data[0], value.data[1]))?.records ?? [] : [] };
          });
          return tradesFrom(shards).map((t) => ({ ...t, market: market.symbol }));
        }).sort((a, b) => b.time - a.time || (BigInt(b.sequence) > BigInt(a.sequence) ? 1 : -1));
      } catch {
        setState((previous) => ({ ...previous, status: "unavailable" }));
        return;
      }
      // Each market's shards keep only its latest fills: merge, so the feed
      // grows into a history while the page is open.
      setState((previous) => {
        const seen = new Set(fills.map((f) => `${f.market}:${f.sequence}`));
        const merged = [...fills, ...previous.fills.filter((f) => !seen.has(`${f.market}:${f.sequence}`))]
          .sort((x, y) => y.time - x.time || (BigInt(y.sequence) > BigInt(x.sequence) ? 1 : -1));
        return { fills: merged.slice(0, 100), status: "live" };
      });
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [enabled]);
  return state;
}
