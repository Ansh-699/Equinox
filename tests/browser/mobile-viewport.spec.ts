import { test, expect } from "@playwright/test";

// Scoped to this file rather than a new Playwright project so it doesn't
// re-run the entire suite at a second viewport -- a project would double
// total run time for coverage this suite already gets at desktop width.
test.use({ viewport: { width: 375, height: 667 } });

test("the login flow works at a real mobile viewport width", async ({ page }) => {
  await page.goto("/trade");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });
});

test("the chart and order ticket stack in a single column, ticket first, not overlapping", async ({ page }) => {
  await page.goto("/trade");
  const marketPanel = page.locator(".market-panel");
  const orderPanel = page.locator(".order-panel");
  await expect(marketPanel).toBeVisible();
  await expect(orderPanel).toBeVisible();
  const marketBox = await marketPanel.boundingBox();
  const orderBox = await orderPanel.boundingBox();
  expect(marketBox).not.toBeNull();
  expect(orderBox).not.toBeNull();
  // Single column, SlipStream order: the ticket comes first on a phone, so the
  // chart starts at or below where the ticket ends -- never side by side.
  expect(marketBox!.y).toBeGreaterThanOrEqual(orderBox!.y + orderBox!.height - 1);
});

test("no horizontal page overflow at mobile width", async ({ page }) => {
  await page.goto("/activity");
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
});

test("the skip link is still present and functional at mobile width", async ({ page }) => {
  await page.goto("/trade");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
});
