# Equinox demo recording

Record the live TSLA trade on a weekday while Pyth reports an open session. US holidays and weekends close TSLA by design; OpenAI, SpaceX, and Anthropic pre-IPO markets remain available around the clock. Use the production site: https://equinox.ansht.workers.dev.

## Before recording

1. Open the app and docs once to warm the browser cache, then keep the tab open.
2. On the landing preview, check that the transaction meter is moving. On Trade, check that the book has bids and asks and the Pyth oracle status is fresh. If the market maker restarts, wait a few seconds for the book to refill.
3. Connect the devnet wallet and check its test USDC and SOL. Rehearse a small order and close so the account is ready. Keep the browser at 100% zoom and hide notifications.
4. Confirm Pulse shows ORCHARD (new), TENSOR (final stretch), and GIGA (graduated to DAMM v2) with their images and curve progress.

## Two to three minute take

| Time | Screen | Show |
| --- | --- | --- |
| 0:00–0:10 | Landing | Headline, sponsor logos, live tx/s preview, Architecture tab. |
| 0:10–0:30 | Trade onboarding | Connect, Start trading, one wallet signature, test funds; show that subsequent orders have no wallet popup. |
| 0:30–1:00 | TSLA | Place a small order while the Pyth session is open, point to the millisecond toast, book row and transaction feed, then close from the position card. |
| 1:00–1:30 | Pre-IPO | Buy the AI labs basket and show both fills. |
| 1:30–2:00 | Launch | Pulse board, a small quick-buy on an active curve, then GIGA's graduated DAMM v2 pool and perp listing state. |
| 2:00–2:20 | Docs | Order lifecycle and price-source diagrams. |
| 2:20–2:30 | Landing/footer | 2–15 ms order path, 27 delegated accounts per market, custody on Solana, repo and docs links. |

Do not call GIGA a live perp until its market is actually listed; the current board says “Perp listing queued.” If TSLA is closed, record the pre-IPO and Launch portions now and capture the TSLA portion on the next open weekday session.
