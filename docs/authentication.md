# Authentication

Privy access tokens are verified server-side and exchanged for a random
application cookie. D1 stores only its SHA-256 hash and session metadata.
Cookies are HttpOnly, Secure in production and SameSite=Lax. CSRF, origin,
expiry, revocation, cleanup and rate limits are enforced. Raw tokens and raw
cookie values are never persisted.
