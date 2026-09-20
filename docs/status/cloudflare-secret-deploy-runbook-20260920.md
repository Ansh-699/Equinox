# Cloudflare secret/deploy handoff

This is a redacted execution sheet for the first reauthorized operator. It
contains no secret values. Run from `workers/` after `wrangler whoami` confirms
the intended Cloudflare account. Wrangler prompts for each value interactively;
never put a credential in a command argument, shell history, log, or tracked
file.

## Required production secrets

The deployed relayer/oracle path needs these server-only bindings:

```text
INGESTION_TOKEN
PRIVY_APP_ID
PRIVY_APP_SECRET
PYTH_PRO_API_KEY
RELAYER_SERVICE_TOKEN
RELAYER_KEYPAIR_JSON
```

`RELAYER_KEYPAIR_JSON` must be the approved fee-payer keypair and must be
validated against the public fee-payer address before entry. The same
`RELAYER_SERVICE_TOKEN` must be installed in the Next.js server runtime as
`STOCKSTREAM_RELAYER_TOKEN`; it must never be exposed to browser variables.

## Install or rotate a secret

Run once per environment, supplying the value only at Wrangler's hidden
prompt. Repeat for every name above:

```bash
cd workers
wrangler secret put INGESTION_TOKEN --env staging
wrangler secret put PRIVY_APP_ID --env staging
wrangler secret put PRIVY_APP_SECRET --env staging
wrangler secret put PYTH_PRO_API_KEY --env staging
wrangler secret put RELAYER_SERVICE_TOKEN --env staging
wrangler secret put RELAYER_KEYPAIR_JSON --env staging

wrangler secret put INGESTION_TOKEN --env production
wrangler secret put PRIVY_APP_ID --env production
wrangler secret put PRIVY_APP_SECRET --env production
wrangler secret put PYTH_PRO_API_KEY --env production
wrangler secret put RELAYER_SERVICE_TOKEN --env production
wrangler secret put RELAYER_KEYPAIR_JSON --env production
```

Use `wrangler secret list --env staging` and `wrangler secret list --env
production` only to check names/status; do not copy secret values into this
repository.

## Validate and deploy

```bash
cd workers
npm run check
npx wrangler deploy --dry-run --env staging
npx wrangler check startup --env staging
npx wrangler deploy --dry-run --env production
npx wrangler check startup --env production
npx wrangler deploy --env staging
npx wrangler deploy --env production
```

After deployment, verify only non-secret presence booleans and public routes:

```bash
curl -fsS https://stockstream-market-api-staging.<account-subdomain>.workers.dev/debug/env-presence
curl -fsS https://stockstream-market-api.anshtyagi.workers.dev/health
curl -fsS 'https://stockstream-market-api.anshtyagi.workers.dev/v1/v3/markets/47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso?domain=l1'
```

The production presence endpoint must never be enabled as a public diagnostic
route beyond the existing authenticated deployment policy; it returns boolean
presence only and never values. Before any live relay test, run the redacted
Privy preflight and Pyth catalog/stream probes from the repository scripts.
Do not submit a transaction until both identity linkage and oracle entitlement
have passed.
