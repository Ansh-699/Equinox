import { test, expect } from "@playwright/test";

// Scoped to this file rather than a new Playwright project so it doesn't
// re-run the entire suite at a second viewport -- a project would double
// total run time for coverage this suite already gets at desktop width.
test.use({ viewport: { width: 375, height: 667 } });

test("the login flow works at a real mobile viewport width", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });
});

test("the settlement lifecycle panel and order ticket stack in a single column, not overlapping", async ({ page }) => {
  await page.goto("/");
  const marketPanel = page.locator(".market-panel");
  const orderPanel = page.locator(".order-panel");
  await expect(marketPanel).toBeVisible();
  await expect(orderPanel).toBeVisible();
  const marketBox = await marketPanel.boundingBox();
  const orderBox = await orderPanel.boundingBox();
  expect(marketBox).not.toBeNull();
  expect(orderBox).not.toBeNull();
  // Stacked in a single column means the order panel starts at or below
  // where the market panel ends -- not side-by-side (which would mean a
  // shared vertical range and a much narrower individual width than the
  // viewport).
  expect(orderBox!.y).toBeGreaterThanOrEqual(marketBox!.y + marketBox!.height - 1);
});

test("no horizontal page overflow at mobile width", async ({ page }) => {
  await page.goto("/activity");
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
});

test("the skip link is still present and functional at mobile width", async ({ page }) => {
  await page.goto("/");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
});
