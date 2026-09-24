# Market API Worker

The Cloudflare Worker serves market reads and operational APIs for Equinox. D1 stores indexed market metadata, faucet claims, and launches; the `MarketStream` Durable Object distributes live market events. The Worker has no wallet authority over the L1 vault. The [root diagram](../README.md#how-the-pieces-fit) shows its place in the system.

## Main routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Worker health and environment |
| `GET /v1/markets`, `GET /v1/markets/:symbol` | Registered market metadata |
| `GET /v1/v3/markets/:core?domain=l1\|er` | Complete V3 account aggregate from one chain domain |
| `GET /v1/markets/TSLA-PERP/candles` | Pyth history for the TSLA chart |
| `GET /v1/pre-ipo`, `GET\|POST /v1/launches` | PreStocks view and verified Meteora launch registry |
| `POST /v1/oracle/refresh` | Refresh the authenticated TSLA Pyth snapshot |
| `POST /v1/faucet` | Privy-verified devnet claim, limited per wallet |
| `GET /v1/mm/status` | Proxy for the market-maker service's status |
| `POST /v1/ingest/market`, `POST /v1/ingest/market-event` | Authenticated indexer input |
| `POST /v1/relay/session` | Authenticated, validated session transaction relay |

`src/index.ts` routes requests; `src/v3-routes.ts` reads and validates shard bundles. D1 schema changes live in `migrations/`. Keep authentication and input validation at the route boundary: a public browser request must not acquire an ingestion or relay credential.

## Local development

Run these commands from `workers/`:

```bash
npm install
npm run types
npx wrangler d1 migrations apply stockstream-index --local --config wrangler.jsonc
npm run dev                 # http://localhost:8787/health
```

`wrangler.jsonc` already declares the D1 binding, Durable Object, public vars, and required secret names. Supply local secret values through an untracked `.dev.vars`; do not commit that file. Live RPC, Pyth, Privy, keeper, ingestion, and relay credentials are separate bindings. The browser never receives them.

Useful checks and release commands:

```bash
npm run check               # TypeScript
npm test                    # Worker unit tests
npm run deploy:dry-run       # inspect a deploy without publishing
npm run deploy              # publish with Wrangler
```

The frontend's market reads can also use a direct MagicBlock RPC path; the Worker V3 aggregate is a validated fallback. The Rust [market-maker service](../services/market-maker/README.md) owns quoting and keeper execution. For live configuration and dated evidence, use [`docs/status/current.md`](../docs/status/current.md).
