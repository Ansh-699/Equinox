# Launch and Pre-IPO demo

Use this as a live walkthrough or a recording script for the Pre-IPO and Launch pages.

## Prepare the stage

1. Open `/pre-ipo`, `/trade`, `/launch`, and `/portfolio` in the same browser session. Connect a devnet wallet and unlock the Equinox trading account before recording. Keep enough test USDC and SOL for the actions below.
2. On `/pre-ipo`, confirm the three perp cards show prices and that the **AI labs** basket shows a margin estimate. On `/trade?market=OPENAI-PERP`, confirm the market is active and the book has bids and asks. If the price or book is unavailable, use the read-only portion and do not submit the basket.
3. On `/launch`, confirm **ORCHARD** appears under New pairs, **TENSOR** under Final stretch, and **GIGA** under Graduated. These are seeded devnet launches; check their actual state before narrating it. A missing or moved row should be described by its current stage, never as a fixed percentage.
4. Set browser zoom to 100%, close unrelated tabs and notifications, and rehearse the exact order size. Use a small size that the account can support. Record the explorer links or transaction signatures after successful actions.

## Read-aloud script (about 2½ minutes)

The **Action** column is what you do on screen. The **Say** column is the voiceover. Pause after each click so the viewer sees the result before you continue. Prices, percentages, and timings are intentionally omitted from the spoken lines because they change.

| Time | Action | Say |
| --- | --- | --- |
| 0:00–0:10 | Start on `/pre-ipo`, with the heading and three perp cards in view. | “Equinox brings pre-IPO token prices into a fast perpetual futures market. Here are OpenAI, SpaceX, and Anthropic, traded with test USDC on Solana devnet.” |
| 0:10–0:24 | Move the cursor across one card’s **PreStocks mark**, **Token on-chain**, and **Token vs mark** rows. Pause on the premium or discount. | “The PreStocks mark gives a reference value. The token trades at its own on-chain price, which may be above or below that mark. We show both, so the price source is visible before anyone trades.” |
| 0:24–0:38 | Click **Trade** on OpenAI. Point to its price, book, and buy/sell ticket. Then return to `/pre-ipo`. | “Equinox turns that token price into a perp market. Orders match on MagicBlock’s rollup; traders take long or short exposure without buying the underlying token.” |
| 0:38–0:54 | Scroll to **Baskets**. Select **AI labs**, **Long**, a modest USD size, and your rehearsed leverage. Point to OpenAI and Anthropic legs, then **Margin needed**. | “For a broader view, I can trade the AI labs basket. Equinox plans two orders, one for OpenAI and one for Anthropic, with margin calculated separately for each market.” |
| 0:54–1:10 | Click **Buy AI labs** if both markets and funding are ready. Wait for the receipt; point to the two legs, timing, and one explorer link. Open **See positions in the terminal**. | “One action submitted both legs. Here are the fills, their execution times, and the resulting positions. Each settles in test USDC.” |
| 1:10–1:24 | Click **Launch**. Sweep the cursor across **New pairs**, **Final stretch**, and **Graduated** on Pulse. | “Now the other side of Equinox: Pulse is where a stock-themed token is created, discovered, and traded. These columns show its actual lifecycle, from a new bonding curve to a graduated pool.” |
| 1:24–1:43 | Click **Create launch**. Select two curve presets to show the fee chart changing. Enter the prepared name and symbol; hold on the preview. | “A creator chooses a Meteora curve and fee schedule, names the token, and sees the launch terms before signing. The launch starts in USDC, and its progress is visible to everyone on the board.” |
| 1:43–1:59 | Close the panel. Set **Quick buy** to a small test amount. Click the buy button on an active curve; show the confirmed transaction and progress bar. | “A buy moves the token along the curve. This transaction is on Solana devnet, and Pulse reads the updated pool state from the chain.” |
| 1:59–2:15 | Point to a graduated row such as GIGA, its DAMM v2 link, then its listing text. | “When a curve reaches its target, anyone can graduate liquidity to Meteora’s DAMM v2 pool. That pool can then become the price source for a new Equinox perp. Until a perp is actually listed, Pulse labels it queued.” |
| 2:15–2:30 | Return to a view with the Pre-IPO and Launch navigation visible, or use the landing end frame. | “That is the full loop: transparent token prices become fast long and short markets, and a new launch can grow into a pool that supports the next market.” |

### If a live action is unavailable

- **Basket order cannot be placed:** stop at the two planned legs and margin estimate. Say: “This is the order the trader is about to submit. Each leg executes in its own market.” Skip the fill claim and move to Launch.
- **Launch buy cannot be placed:** show an existing active curve and its progress. Say: “Each confirmed buy moves this curve forward; Pulse reads the current state from Solana.”
- **Create launch is part of the actual demo:** after the preview, click **Launch [symbol]**, wait for confirmation, show the new New pairs row and transaction link, then continue to a pre-seeded active curve for the quick buy. Allow roughly 30 extra seconds.
- **Graduated pool has no perp link:** say “Perp listing queued.” The DAMM v2 pool is live; the Equinox perp is a separate listing step.

## Presenter checkpoints

### Pre-IPO: the story in four steps

1. **Discover:** three supported PreStocks-linked perp markets, then the full token table. The table’s **Swap** action goes to a mainnet token venue; keep this distinction visible.
2. **Understand price:** compare issuer mark with on-chain token price and the premium or discount. Point out that the reporter posts a bounded token-based price to Solana; the mark is context, not the fill price.
3. **Trade:** show long/short, size, leverage, estimated margin, and the order result. Use the AI labs basket to demonstrate OpenAI and Anthropic in parallel; use a single market to show the order book and position controls.
4. **Verify:** show the fill/transaction link and resulting position. Do not promise a fixed latency; narrate the timing the UI actually reports.

### Launch: the story in four steps

1. **Create:** pick a Meteora Dynamic Bonding Curve preset, name the stock-themed token, inspect the fee chart and preview, then launch if this is part of the recording.
2. **Trade the curve:** use Quick buy on a New pairs or Final stretch token. Show curve progress and the transaction link after confirmation.
3. **Graduate:** explain that at 100% the **Graduate to DAMM v2** action becomes available. Show a previously graduated pool if the live token is not at 100%; do not imply a sub-100% pool can graduate.
4. **Connect to perps:** point to **Perp listing queued** or a real **Trade** link. Listing is a separate step after pool graduation; show it as future capability when no market exists.

## Short version for a 30-second clip

1. **0–8s:** Pre-IPO cards: “OpenAI, SpaceX, and Anthropic perp markets anchored to PreStocks token prices.”
2. **8–17s:** AI labs basket: show the two legs, margin, and receipt if available. “One action, two isolated positions.”
3. **17–26s:** Pulse board: New pairs → Final stretch → Graduated; quick buy or show a confirmed transaction. “A USDC curve becomes a DAMM v2 pool.”
4. **26–30s:** GIGA state and Equinox logo. “Graduated pools can become the price source for new perps.”

## Recording rules

- Read live values from the screen. Seeded tokens, pool progress, prices, timing, and transaction counts can change.
- Only call a launch perp **live** when Pulse links to its actual Equinox trade market. Otherwise call it **queued** or **a possible next listing**.
