// Live check: Pre-IPO basket. Fresh wallet → /pre-ipo → AI labs basket, long
// $1000 at 2× → both legs (OPENAI-PERP, ANTHROPIC-PERP) filled; one wallet prompt.
// Run: npx tsx scripts/e2e/basket.mts
import { launch, SITE } from "./harness.mts";

const { page, prompts, step, connect, close } = await launch();
try {
  await connect();
  await page.goto(SITE.replace(/\/trade$/, "/pre-ipo"), { waitUntil: "load" });
  await page.getByText("OPENAI-PERP").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /^AI labs/ }).click();
  const started = Date.now();
  await page.getByRole("button", { name: /Buy AI labs/ }).click();
  const status = page.locator('section[aria-label="Pre-IPO baskets"] [role="status"]');
  await status.waitFor({ timeout: 120_000 });
  const text = (await status.innerText()).replace(/\s+/g, " ");
  step(`result after ${Date.now() - started} ms: ${text}`);
  if (!/bought · 2 legs/.test(text)) throw new Error(`basket failed: ${text}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  if (prompts.length !== 1) throw new Error("expected exactly one wallet prompt");
  console.log("PASS basket");
} finally {
  await page.screenshot({ path: "test-results/e2e-basket.png" }).catch(() => undefined);
  await close();
}
