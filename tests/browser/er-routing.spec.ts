import { test, expect, type Page } from "@playwright/test";

const RELAYER_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_RELAYER_PORT ?? 4182}/control`;
const MARKET_API_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_MARKET_API_PORT ?? 4183}/control`;

async function setExecutionStatus(status: string) {
  await fetch(MARKET_API_CONTROL_URL, { method: "POST", body: JSON.stringify({ status }) });
}

async function login(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });
  // The wallet address resolves before the app session (auth.authenticated)
  // finishes its own async POST /api/auth/session -- authorizeSession()
  // needs the LATTER, or it can race a still-null `protocol` on a cold
  // (not-yet-warmed) dev server and silently no-op.
  await expect(page.getByRole("region", { name: "StockStream status" }).getByText("authenticated", { exact: true })).toBeVisible({ timeout: 10_000 });
}

async function authorizeSession(page: Page) {
  await page.getByRole("button", { name: "Authorize session" }).click();
  await expect(page.getByRole("button", { name: "Revoke session" })).toBeVisible({ timeout: 10_000 });
}

// The app polls execution-status every 5s (features/magicblock/use-
// execution-status.ts) -- after steering the mock to a new status, wait
// for the banner to actually reflect it (rather than a fixed sleep) before
// acting, so the test exercises the real polled value, not a stale one.
// Every non-l1_only status this suite uses stops showing "not delegated",
// so that's a reliable, status-agnostic signal the poll caught up.
async function waitForExecutionStatusPolled(page: Page) {
  await expect(page.locator('.status-strip[aria-live="polite"]')).not.toContainText("not delegated", { timeout: 10_000 });
}

test.beforeEach(async () => {
  await fetch(RELAYER_CONTROL_URL, { method: "POST", body: JSON.stringify({ mode: "success", resetNonce: true }) });
  await setExecutionStatus("l1_only");
});

test("orders route through the ER while the market is genuinely ER-delegated", async ({ page }) => {
  await page.goto("/");
  await login(page);
  await authorizeSession(page);
  await setExecutionStatus("er_active");
  await waitForExecutionStatusPolled(page);

  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
});

test("orders continue routing through the ER across commit progress -- commit_finalized is still ER-owned", async ({ page }) => {
  await page.goto("/");
  await login(page);
  await authorizeSession(page);
  await setExecutionStatus("commit_finalized");
  await waitForExecutionStatusPolled(page);

  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
});

for (const status of ["delegating", "undelegating", "restoration_pending", "reconciliation_error"]) {
  test(`orders are refused, not silently mis-routed, while the market is "${status}"`, async ({ page }) => {
    await page.goto("/");
    await login(page);
    await authorizeSession(page);
    await setExecutionStatus(status);
    await waitForExecutionStatusPolled(page);

    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.locator(".notice")).toContainText("mid-transition between L1 and the ER", { timeout: 10_000 });
    await expect(page.locator(".notice")).not.toContainText("Relayed");
  });
}
