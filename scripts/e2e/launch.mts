// Live check: Meteora launchpad. Fresh wallet → /launch → quick-graduate
// preset → launch (signed by the trading account) → the pool shows in the
// monitor → buy $100 on the curve → progress moves.
// Run: SITE=https://equinox.ansht.workers.dev/launch npx tsx scripts/e2e/launch.mts
import { launch } from "./harness.mts";

const { page, prompts, step, connect, close } = await launch();
const symbol = `E2E${Math.floor(Math.random() * 9000 + 1000)}`;
try {
  await connect();
  await page.getByRole("radio", { name: /Quick graduate/ }).click();
  await page.getByLabel("Token name").fill(`E2E ${symbol}`);
  await page.getByLabel("Symbol").fill(symbol);
  await page.getByRole("button", { name: new RegExp(`Launch ${symbol}`) }).click();
  await page.getByText("Pool live on devnet").waitFor({ timeout: 120_000 });
  step("pool created");
  const card = page.locator('section[aria-label="Launches"] > div > div').filter({ hasText: symbol });
  await card.waitFor({ timeout: 60_000 });
  step(`monitor: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
  await card.getByRole("button", { name: "Buy $100" }).click();
  await card.getByText(/Buying \$100 .* · done/).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(12_000); // the monitor refreshes every 10 s
  step(`after buy: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  console.log("PASS launch");
} finally {
  await page.screenshot({ path: "test-results/e2e-launch.png", fullPage: true }).catch(() => undefined);
  await close();
}
