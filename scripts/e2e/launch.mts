// Live check: Meteora launchpad (Pulse). Fresh wallet → /launch → Create
// launch → quick-graduate preset → launch (signed by the trading account) →
// the card shows in New pairs → ⚡ quick buy → progress moves.
// Run: SITE=https://equinox.ansht.workers.dev/launch npx tsx scripts/e2e/launch.mts
import { launch } from "./harness.mts";

const { page, prompts, step, connect, close } = await launch();
const symbol = `E2E${Math.floor(Math.random() * 9000 + 1000)}`;
try {
  await connect();
  await page.getByRole("button", { name: "Create launch" }).click();
  await page.getByRole("radio", { name: /Quick graduate/ }).click();
  await page.getByLabel("Token name").fill(`E2E ${symbol}`);
  await page.getByLabel("Symbol").fill(symbol);
  await page.getByRole("button", { name: `Launch ${symbol}` }).click();
  await page.getByText(`${symbol} is live on devnet`).waitFor({ timeout: 120_000 });
  step("pool created");
  await page.keyboard.press("Escape");
  const card = page.locator("article").filter({ hasText: symbol });
  await card.waitFor({ timeout: 60_000 });
  step(`card: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
  await card.getByRole("button", { name: "$25" }).click();
  await card.getByText(/Buying \$25 .* · done/).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(14_000); // Pulse refreshes every 12 s
  step(`after buy: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  console.log("PASS launch");
} finally {
  await page.screenshot({ path: "test-results/e2e-launch.png", fullPage: true }).catch(() => undefined);
  await close();
}
