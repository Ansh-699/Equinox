/**
 * `@solana/addresses`'s `getProgramDerivedAddress` (used by
 * `relay-auth.ts::deriveTradingSessionAddress`) gates every crypto
 * operation on `globalThis.isSecureContext`. Real deployed Cloudflare
 * Workers always run in a secure (HTTPS-equivalent) context, so this is
 * `true` in production -- but this Miniflare/workerd test isolate leaves
 * it `undefined`, which is a test-harness gap, not a real security
 * property this suite should exercise. Set it once here rather than
 * scattering the same shim across every test file that touches PDA
 * derivation.
 */
(globalThis as { isSecureContext?: boolean }).isSecureContext = true;
