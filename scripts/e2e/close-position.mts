// Live check: open a position, rest a limit order, then close the position
// from its card (reduce-only market close) and cancel the order from its card.
// Run: npx tsx scripts/e2e/close-position.mts
import { launch } from "./harness.mts";

const { page, step, waitNotice, connect, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: "Start trading", exact: true }).click();
  await waitNotice(/Deposited 100 USDC/);
  await page.waitForFunction(() => /Available\s*\$[1-9]/.test(document.querySelector("section.lifecycle-panel")?.textContent ?? ""), null, { timeout: 30_000 });

  await page.getByRole("button", { name: "Market", exact: true }).click();
  await page.locator("#order-amount").fill("80");
  await page.locator("#order-lev").fill("5");
  await page.locator('section[aria-label="Place order"] button').filter({ hasText: /Place order/ }).click();
  await waitNotice(/Order accepted by the MagicBlock rollup/, 30_000);
  const card = page.locator("#activity-panel article").filter({ hasText: /Long|Short/ });
  await card.first().waitFor({ timeout: 20_000 });
  step(`position card: ${(await card.first().innerText()).replace(/\s+/g, " ")}`);

  const mid = Number((await page.locator("#book-panel .text-\\[19px\\]").innerText()).replace(/[^0-9.]/g, ""));
  await page.getByRole("button", { name: "Limit", exact: true }).click();
  await page.locator("#order-price").fill((mid * 0.985).toFixed(2));
  await page.locator("#order-lev").fill("1");
  await page.locator("#order-amount").fill("380"); // one share at 1×, ~$75 margin
  await page.locator('section[aria-label="Place order"] button').filter({ hasText: /Place order/ }).click();
  await waitNotice(/Order accepted by the MagicBlock rollup/, 30_000);
  await page.getByRole("tab", { name: "Open Orders" }).click();
  const order = page.locator('section[aria-label="Open orders"] article').first();
  await order.waitFor({ timeout: 20_000 });
  step(`order card: ${(await order.innerText()).replace(/\s+/g, " ")}`);
  await page.screenshot({ path: "test-results/e2e-cards.png" });
  await order.getByRole("button", { name: "Cancel" }).click();
  await order.waitFor({ state: "detached", timeout: 15_000 });
  step("order cancelled from its card");

  await page.getByRole("tab", { name: "Positions" }).click();
  await page.locator("#activity-panel").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText(/No open position/).waitFor({ timeout: 20_000 });
  step("position closed from its card");
  console.log("PASS close-position");
} finally {
  await page.screenshot({ path: "test-results/e2e-close-position.png" }).catch(() => undefined);
  await close();
}
