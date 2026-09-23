// Live check: a seat owned by the main wallet itself (created and funded with
// wallet signatures, no trading key), then instant trading is enabled and the
// card takes that seat's collateral back out to the wallet.
// Run: npx tsx scripts/e2e/wallet-seat.mts
import { launch } from "./harness.mts";

const { page, prompts, step, waitNotice, connect, walletUsdc, close } = await launch();
try {
  await connect();
  await page.getByRole("button", { name: "Get test USDC" }).click();
  await waitNotice(/Sent 1,000 test USDC/, 60_000);
  await page.getByText("Advanced order tools").click();
  await page.getByRole("button", { name: "Create seat only" }).click();
  await waitNotice(/Seat #\d+ created in the rollup/, 60_000);
  await page.locator("#custody-amount").fill("50");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await waitNotice(/Deposited 50 USDC/);
  step(`wallet USDC after deposit: ${await walletUsdc()}`);

  await page.getByRole("button", { name: "Enable instant trading" }).click();
  await page.getByText(/Your wallet's own seat #\d+ still holds \$50\.00/).waitFor({ timeout: 30_000 });
  step("card shows the wallet seat");
  await page.getByRole("button", { name: /Withdraw it to your wallet/ }).click();
  await waitNotice(/Withdrew 50 USDC/);
  step(`wallet USDC after withdraw: ${await walletUsdc()}`);
  step(`wallet prompts: ${prompts.join(", ")}`);
  console.log("PASS wallet-seat");
} finally {
  await page.screenshot({ path: "test-results/e2e-wallet-seat.png" }).catch(() => undefined);
  await close();
}
