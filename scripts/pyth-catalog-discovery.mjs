#!/usr/bin/env node
/**
 * Queries Pyth Pro's authenticated symbol catalog without ever printing the
 * API key. The numeric `pyth_lazer_id` is the only value valid for
 * PYTH_PRO_FEED_ID; it is deliberately not inferred from a Hermes hash.
 *
 * Example (the ignored runtime file is loaded by Node, never committed):
 *   node --env-file=.env.local scripts/pyth-catalog-discovery.mjs AAPL
 */

const apiKey = process.env.PYTH_PRO_API_KEY;
if (!apiKey || apiKey.length < 8) {
  console.error("PYTH_PRO_API_KEY is not set in the runtime environment");
  process.exit(1);
}

const query = process.argv[2] ?? "AAPL";
if (!/^[A-Za-z0-9._/-]{1,64}$/.test(query)) {
  console.error("query must contain only letters, digits, '.', '_', '/', or '-'");
  process.exit(1);
}

const url = new URL("https://pyth.dourolabs.app/v1/symbols");
url.searchParams.set("query", query);
url.searchParams.set("asset_type", "equity");

const response = await fetch(url, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
if (!response.ok) {
  console.error(`Pyth catalog request failed: HTTP ${response.status}`);
  process.exit(1);
}

const payload = await response.json();
const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload?.symbols;
if (!Array.isArray(rows)) {
  console.error("Pyth catalog returned an unrecognized response shape");
  process.exit(1);
}

const discovered = rows
  .filter((row) => Number.isSafeInteger(row?.pyth_lazer_id) && typeof row?.symbol === "string")
  .map((row) => ({
    symbol: row.symbol,
    pythLazerId: row.pyth_lazer_id,
    minChannel: row.min_channel ?? null,
    state: row.state ?? null,
  }));

console.log(JSON.stringify({ query, feeds: discovered }, null, 2));
const aapl = discovered.find((row) => row.symbol === "Equity.US.AAPL/USD" && row.state === "stable");
if (aapl) {
  console.log(`\nSafe runtime configuration (do not commit): PYTH_PRO_FEED_ID=${aapl.pythLazerId}`);
  console.log(`Safe runtime configuration (do not commit): PYTH_PRO_MIN_CHANNEL=${aapl.minChannel}`);
}
