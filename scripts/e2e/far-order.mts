// Live check for the "my order isn't in the book" bug: rest a short limit
// ~1.5% above the market (beyond the market maker's rungs), see it in the book
// marked as yours, cancel it, and check the maker's ladder is still there.
// Run: npx tsx scripts/e2e/far-order.mts
import { launch } from "./harness.mts";

const { page, step, waitNotice, connect, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: "Start trading", exact: true }).click();
  await waitNotice(/Deposited 100 USDC/);
  await page.waitForFunction(() => /Available\s*\$[1-9]/.test(document.querySelector("section.lifecycle-panel")?.textContent ?? ""), null, { timeout: 30_000 });

  const mid = Number((await page.locator("#book-panel .text-\\[19px\\]").innerText()).replace(/[^0-9.]/g, ""));
  const price = (mid * 1.015).toFixed(2);
  await page.getByRole("button", { name: "Limit", exact: true }).click();
  await page.getByRole("button", { name: /Short/ }).click();
  await page.locator("#order-price").fill(price).catch(async () => page.getByLabel(/Limit price/).fill(price));
  await page.locator("#order-amount").fill("200");
  await page.locator('section[aria-label="Place order"] button').filter({ hasText: /Place order/ }).click();
  const placedAt = Date.now();
  const mine = page.locator("#book-panel [data-mine]");
  await mine.first().waitFor({ timeout: 15_000 });
  step(`own ask visible in the book after ${Date.now() - placedAt} ms: ${(await mine.first().innerText()).replace(/\s+/g, " ")} (limit ${price}, mid ${mid})`);

  await page.getByRole("tab", { name: "Open Orders" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await mine.first().waitFor({ state: "detached", timeout: 15_000 });
  step("own ask gone after cancel");
  await page.waitForTimeout(5_000);
  const levels = await page.locator("#book-panel .grid.h-5").count();
  step(`book levels 5 s after cancel: ${levels}`);
  if (levels < 30) throw new Error(`maker ladder looks broken: only ${levels} levels`);
  console.log("PASS far-order");
} finally {
  await page.screenshot({ path: "test-results/e2e-far-order.png" }).catch(() => undefined);
  await close();
}
