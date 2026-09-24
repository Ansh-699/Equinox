/** Pre-IPO token prices from PreStocks, proxied because the API sends no
 * CORS headers. (PreStocks only: its bounty excludes other pre-IPO tokens.) Display data only: never used for margin or risk. */
export interface PreIpoToken {
  issuer: "PreStocks";
  name: string;
  symbol: string;
  mint: string;
  /** Issuer's reference price for the underlying private company. */
  markPrice: number;
  /** On-chain token price, when the issuer publishes one. */
  tokenPrice: number | null;
  markValuation: number | null;
  sector: string | null;
  image: string | null;
  url: string | null;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

export function normalizePreStocks(rows: unknown): PreIpoToken[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>;
    const mint = str(r.contract_address), mark = num(r.markPrice);
    if (!mint || mark === null) return [];
    return [{ issuer: "PreStocks" as const, name: str(r.name) ?? mint, symbol: str(r.symbol) ?? "", mint, markPrice: mark, tokenPrice: num(r.tokenPrice), markValuation: num(r.markValuation), sector: null, image: str(r.image), url: str(r.external_url) }];
  });
}

let cached: { at: number; tokens: PreIpoToken[] } | null = null;

export async function fetchPreIpoTokens(fetcher: typeof fetch = fetch, now = Date.now()): Promise<PreIpoToken[]> {
  if (cached && now - cached.at < 60_000) return cached.tokens;
  const get = (url: string) => fetcher(url, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const tokens = normalizePreStocks(await get("https://prestocks.com/api/prestocks"));
  if (tokens.length) cached = { at: now, tokens };
  return tokens;
}
