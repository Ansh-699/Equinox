// Live speed probe: fresh wallet → Start trading → 5 limit bids well below the
// market, timing click → "accepted" and click → visible in Open Orders.
// Run: npx tsx scripts/e2e/speed.mts
import { launch } from "./harness.mts";

const { page, step, waitNotice, connect, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: "Start trading" }).click();
  await waitNotice(/Deposited 100 USDC/);
  await page.waitForFunction(() => /Available\s*\$[1-9]/.test(document.querySelector("section.lifecycle-panel")?.textContent ?? ""), null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Limit", exact: true }).click();
  await page.getByRole("tab", { name: "Open Orders" }).click().catch(() => undefined);
  // In-page clock: click → the status line saying accepted → the price showing in Open Orders.
  await page.evaluate(() => {
    const w = window as unknown as { __t: { click: number; accepted: number; visible: number; price: string } };
    w.__t = { click: 0, accepted: 0, visible: 0, price: "" };
    document.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest('section[aria-label="Place order"] button.w-full')) { w.__t.click = performance.now(); w.__t.accepted = 0; w.__t.visible = 0; } }, true);
    new MutationObserver(() => {
      if (!w.__t.click) return;
      if (!w.__t.accepted && /Order accepted|Order placed/.test(document.querySelector(".notice span")?.textContent ?? "")) w.__t.accepted = performance.now();
      if (!w.__t.visible && w.__t.price && (document.querySelector('section[aria-label="Your activity"] table') as HTMLElement | null)?.innerText.includes(`$${w.__t.price}`)) w.__t.visible = performance.now();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const accepted: number[] = [], visible: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const price = (300 + i).toFixed(2); // far below the book: rests
    await page.locator("#order-price").fill(price);
    await page.locator("#order-amount").fill("80");
    await page.locator("#order-lev").fill("5");
    const button = page.locator('section[aria-label="Place order"] button.w-full').last();
    await page.evaluate((p) => { (window as unknown as { __t: { price: string } }).__t.price = p; }, price);
    const t0 = Date.now();
    await button.click({ timeout: 5_000 }).catch(async (error) => { step(`button: ${await button.innerText()}`); throw error; });
    await waitNotice(/Order accepted|Order placed/, 30_000);
    await page.getByText(new RegExp(`\\$?${price.replace(".", "\\.")}`)).first().waitFor({ timeout: 30_000 });
    const t = await page.evaluate(() => (window as unknown as { __t: { click: number; accepted: number; visible: number } }).__t);
    accepted.push(Math.round(t.accepted - t.click));
    for (let i = 0; i < 100 && !(await page.evaluate(() => (window as unknown as { __t: { visible: number } }).__t.visible)); i += 1) await page.waitForTimeout(50);
    visible.push(Math.round((await page.evaluate(() => (window as unknown as { __t: { visible: number } }).__t.visible)) - t.click));
    step(`order ${i + 1} @ ${price}: accepted ${accepted.at(-1)} ms, in Open Orders ${visible.at(-1)} ms`);
  }
  // Rapid fire: five clicks without waiting; every one must be accepted.
  const before = await page.locator('section[aria-label="Your activity"] table tbody tr').count();
  await page.locator("#order-price").fill("299.00");
  const burst = Date.now();
  for (let i = 0; i < 5; i += 1) await page.locator('section[aria-label="Place order"] button.w-full').last().click();
  await page.waitForFunction((n) => document.querySelectorAll('section[aria-label="Your activity"] table tbody tr').length >= n + 5, before, { timeout: 30_000 });
  step(`rapid fire: 5 clicks → all 5 resting in Open Orders after ${Date.now() - burst} ms`);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`SPEED accepted p50 ${med(accepted)} ms · visible p50 ${med(visible)} ms`);
} finally {
  await page.screenshot({ path: "test-results/e2e-speed.png" }).catch(() => undefined);
  await close();
}
