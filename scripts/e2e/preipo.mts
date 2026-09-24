// Live check: pre-IPO perps. Fresh wallet → pick OPENAI-PERP → Start trading
// (seat + deposit in that market) → market buy filled against the bot → the
// position shows. Run: npx tsx scripts/e2e/preipo.mts [SYMBOL]
import { launch } from "./harness.mts";

const symbol = process.argv[2] ?? "OPENAI-PERP";
const { page, prompts, step, waitNotice, connect, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: /Change market/ }).click();
  await page.getByRole("option").filter({ hasText: symbol }).getByRole("button").click();
  await page.getByText(new RegExp(`${symbol}`)).first().waitFor();
  await page.getByText(/V3 delegation: delegated to MagicBlock/).waitFor({ timeout: 30_000 });
  step(`market: ${await page.getByRole("button", { name: /Change market/ }).innerText()}`);
  await page.getByRole("button", { name: "Start trading" }).click();
  await waitNotice(/Deposited 500 USDC/);
  await page.waitForFunction(() => /Available\s*\$[1-9]/.test(document.querySelector("section.lifecycle-panel")?.textContent ?? ""), null, { timeout: 30_000 });
  step(`seat: ${await page.getByRole("button", { name: /Seat #\d+ active/ }).innerText()}`);
  await page.getByRole("button", { name: "Market", exact: true }).click();
  await page.locator("#order-amount").fill("400");
  await page.locator("#order-lev").fill("5");
  await page.locator('section[aria-label="Place order"] button.w-full').last().click();
  await waitNotice(/Order accepted by the MagicBlock rollup/, 30_000);
  await page.getByRole("tab", { name: "Positions" }).click().catch(() => undefined);
  await page.getByText(new RegExp(`${symbol}.*Long|Long`)).first().waitFor({ timeout: 20_000 });
  step(`position row: ${(await page.locator('section[aria-label="Your activity"] table tbody tr').first().innerText()).replace(/\s+/g, " ")}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  console.log(`PASS preipo ${symbol}`);
} finally {
  await page.screenshot({ path: `test-results/e2e-preipo-${symbol}.png` }).catch(() => undefined);
  await close();
}
