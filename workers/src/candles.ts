/** TSLA OHLC history from the Pyth Pro History API (TradingView UDF shape),
 * proxied so the API key never reaches the browser. */
export const CANDLE_RESOLUTIONS = new Set(["1", "5", "15", "60", "240", "D"]);
const MAX_SPAN_SECONDS = 60 * 60 * 24 * 200;
const HISTORY_URL = "https://pyth.dourolabs.app/history/v1/fixed_rate@200ms/history";

export interface CandleQuery { resolution: string; from: number; to: number }

export function parseCandleQuery(params: URLSearchParams): CandleQuery | null {
  const resolution = params.get("resolution") ?? "";
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  if (!CANDLE_RESOLUTIONS.has(resolution) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to - from > MAX_SPAN_SECONDS) return null;
  return { resolution, from, to };
}

export async function fetchCandles(apiKey: string, symbol: string, query: CandleQuery, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const url = `${HISTORY_URL}?symbol=${encodeURIComponent(symbol)}&resolution=${query.resolution}&from=${query.from}&to=${query.to}`;
  const response = await fetcher(url, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) return { s: "error", errmsg: `Pyth history ${response.status}` };
  const body = await response.json() as Record<string, unknown>;
  return { ...body, src: "pyth-pro" };
}
