"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Candle { t: number; o: number; h: number; l: number; c: number }
export interface Resolution { label: string; code: string; seconds: number; lookback: number }

export const RESOLUTIONS: readonly Resolution[] = [
  { label: "1m", code: "1", seconds: 60, lookback: 60 * 60 * 3 },
  { label: "5m", code: "5", seconds: 300, lookback: 60 * 60 * 12 },
  { label: "15m", code: "15", seconds: 900, lookback: 60 * 60 * 36 },
  { label: "1H", code: "60", seconds: 3600, lookback: 60 * 60 * 24 * 7 },
  { label: "4H", code: "240", seconds: 14400, lookback: 60 * 60 * 24 * 30 },
  { label: "1D", code: "D", seconds: 86400, lookback: 60 * 60 * 24 * 180 },
];

const NO_CANDLES: Candle[] = [];

/** Pyth Pro OHLC history (via the market API) with the live verified oracle
 * price merged into the forming candle. Failed refreshes keep the last series. */
export function useCandles(marketApiUrl: string | undefined, symbol: string, resolution: Resolution, live: { price: number; publishTime: number } | null) {
  // Keyed by resolution so a switch never shows candles from another bucket width;
  // a failed refresh keeps the series already loaded for this resolution.
  const [series, setSeries] = useState<{ code: string; candles: Candle[]; error: string | null } | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!marketApiUrl) return;
    const id = ++request.current;
    try {
      const to = Math.floor(Date.now() / 1000);
      const response = await fetch(`${marketApiUrl.replace(/\/$/, "")}/v1/markets/${encodeURIComponent(symbol)}/candles?resolution=${resolution.code}&from=${to - resolution.lookback}&to=${to}`);
      const data = await response.json() as { s?: string; errmsg?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[] };
      if (id !== request.current) return;
      if (data.s !== "ok" || !Array.isArray(data.t)) {
        const error = data.errmsg ?? "no data";
        setSeries((previous) => ({ code: resolution.code, candles: previous?.code === resolution.code ? previous.candles : NO_CANDLES, error }));
        return;
      }
      setSeries({ code: resolution.code, candles: data.t.map((t, i) => ({ t, o: data.o![i], h: data.h![i], l: data.l![i], c: data.c![i] })), error: null });
    } catch (reason) {
      if (id !== request.current) return;
      const error = reason instanceof Error ? reason.message : String(reason);
      setSeries((previous) => ({ code: resolution.code, candles: previous?.code === resolution.code ? previous.candles : NO_CANDLES, error }));
    }
  }, [marketApiUrl, symbol, resolution]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), 60_000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, [load]);

  const current = series?.code === resolution.code ? series : null;
  const history = current?.candles ?? NO_CANDLES;
  const candles = useMemo(() => {
    if (!history.length || !live) return history;
    const out = history.slice();
    const bucket = Math.floor(live.publishTime / resolution.seconds) * resolution.seconds;
    const last = out[out.length - 1];
    if (bucket === last.t) out[out.length - 1] = { ...last, c: live.price, h: Math.max(last.h, live.price), l: Math.min(last.l, live.price) };
    else if (bucket > last.t) out.push({ t: bucket, o: live.price, h: live.price, l: live.price, c: live.price });
    return out;
  }, [history, live, resolution.seconds]);

  return { candles, error: current?.error ?? null, loading: !current };
}
