/** Pre-IPO token prices from PreStocks and Tessera, proxied because neither
 * API sends CORS headers. Display data only: never used for margin or risk. */
export interface PreIpoToken {
  issuer: "PreStocks" | "Tessera";
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

export function normalizeTessera(rows: unknown): PreIpoToken[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>;
    const mint = str(r.mint), mark = num(r.markPrice);
    if (!mint || mark === null) return [];
    return [{ issuer: "Tessera" as const, name: str(r.name) ?? mint, symbol: str(r.symbol) ?? "", mint, markPrice: mark, tokenPrice: null, markValuation: num(r.markValuation), sector: str(r.sector), image: null, url: "https://app.tessera.pe" }];
  });
}

let cached: { at: number; tokens: PreIpoToken[] } | null = null;

export async function fetchPreIpoTokens(fetcher: typeof fetch = fetch, now = Date.now()): Promise<PreIpoToken[]> {
  if (cached && now - cached.at < 60_000) return cached.tokens;
  const get = (url: string) => fetcher(url, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [prestocks, tessera] = await Promise.all([get("https://prestocks.com/api/prestocks"), get("https://rest-api.tessera.pe/v1/public/token-details")]);
  const tokens = [...normalizePreStocks(prestocks), ...normalizeTessera(tessera)];
  if (tokens.length) cached = { at: now, tokens };
  return tokens;
}
