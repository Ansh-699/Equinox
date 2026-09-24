// Live check: brand-new wallet → type an amount → Deposit (without pressing
// Start trading). The only wallet prompt is the one-time trading-key
// signature; faucet, seat and deposit are signed silently, and a second
// deposit prompts nothing. Run: npx tsx scripts/e2e/deposit.mts
import { launch } from "./harness.mts";

const { page, prompts, step, waitNotice, connect, close } = await launch();
try {
  await connect();
  await page.getByText(/Rollup session: live on MagicBlock/).waitFor({ timeout: 30_000 });
  await page.locator("#custody-amount").fill("200");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await waitNotice(/Deposited 200 USDC/);
  step(`first deposit, wallet prompts: ${prompts.join(", ")}`);
  await page.locator("#custody-amount").fill("50");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await waitNotice(/Deposited 50 USDC/);
  step(`after second deposit, wallet prompts: ${prompts.join(", ")}`);
  if (prompts.length !== 1) throw new Error(`expected exactly one wallet prompt, got ${prompts.length}`);
  console.log("PASS deposit");
} finally {
  await page.screenshot({ path: "test-results/e2e-deposit.png" }).catch(() => undefined);
  await close();
}
