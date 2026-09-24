// Live check: brand-new wallet (no SOL, no USDC) → Start trading (one signed
// message) → faucet, rollup seat and deposit signed silently → market buy in
// the rollup → withdraw back to the main wallet. Run: npx tsx scripts/e2e/onboarding.mts
import { launch } from "./harness.mts";

const { page, prompts, step, waitNotice, connect, walletUsdc, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: "Start trading", exact: true }).click();
  await waitNotice(/Deposited 100 USDC/);
  step(`seat: ${await page.getByRole("button", { name: /Delegated session live/ }).innerText()}`);
  await page.waitForFunction(() => /Available\s*\$[1-9]/.test(document.querySelector("section.lifecycle-panel")?.textContent ?? ""), null, { timeout: 30_000 });

  await page.getByRole("button", { name: "Market", exact: true }).click();
  await page.locator("#order-amount").fill("80");
  await page.locator("#order-lev").fill("5");
  await page.locator('section[aria-label="Place order"] button').filter({ hasText: /Place order/ }).click();
  await waitNotice(/Order accepted by the MagicBlock rollup/, 30_000);
  step(`latency: ${(await page.getByText(/You · PlaceOrder/).first().locator("xpath=ancestor::li").innerText()).replace(/\s+/g, " ")}`);
  await page.getByRole("tab", { name: "Positions" }).click().catch(() => undefined);

  await page.locator("#custody-amount").fill("10");
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await waitNotice(/Withdrew 10 USDC to your wallet/);
  step(`main wallet USDC on Solana: ${await walletUsdc()}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  if (prompts.length !== 1) throw new Error("expected exactly one wallet prompt");
  console.log("PASS onboarding");
} finally {
  await page.screenshot({ path: "test-results/e2e-onboarding.png" }).catch(() => undefined);
  await close();
}
