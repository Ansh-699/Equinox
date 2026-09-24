# Equinox Market API

Cloudflare Workers holds no wallet keys and has no authority to settle, liquidate,
or move user funds. It indexes verified Solana/MagicBlock/Meteora events into D1
and fans out live, per-market updates through a Durable Object.

The trusted indexer must register a market through `POST /v1/ingest/market`
before it sends that market's events. Both ingestion endpoints require the same
server-only bearer token.

## Local setup

1. In `workers`, run `npm install` and then `npm run types`.
2. Copy `.dev.vars.example` to `.dev.vars` and supply a development ingestion token.
3. Run `npm run dev` and call `GET /health`.

Before deployment, create a D1 database with `npx wrangler d1 create stockstream-index`,
replace the placeholder `database_id` in `wrangler.jsonc`, run the migration, and set
`INGESTION_TOKEN` with `npx wrangler secret put INGESTION_TOKEN`. The token belongs only
to the trusted indexer/keeper, never the browser.
