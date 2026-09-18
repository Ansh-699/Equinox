import { test, expect, type Page } from "@playwright/test";

/** Manual-checklist item made concrete and repeatable: the entire login ->
 * order-preview path must be reachable and operable with a keyboard alone,
 * no pointer events. This drives real Tab/Enter key presses rather than
 * asserting DOM structure, so it fails if something intercepts focus,
 * traps it, or renders a control unreachable by keyboard. */

async function tabToButtonNamed(page: Page, name: string, maxPresses = 40): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    const matched = await page.evaluate((expected) => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.tagName === "BUTTON" && active.textContent?.trim().includes(expected);
    }, name);
    if (matched) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach a button named "${name}" by keyboard within ${maxPresses} Tab presses`);
}

test("the entire login flow is reachable and operable by keyboard alone", async ({ page }) => {
  await page.goto("/");
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // establish a starting focus point, no widget interaction
  await tabToButtonNamed(page, "Sign in");

  // Focus must be visibly indicated -- a real outline/box-shadow, not
  // `outline: none` with nothing standing in for it.
  const hasVisibleFocusRing = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });
  expect(hasVisibleFocusRing).toBe(true);

  await page.keyboard.press("Enter");
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });

  // Focus must land somewhere real after activation, never silently reset
  // to <body> (which would strand a keyboard user with no visible cursor).
  const focusIsBody = await page.evaluate(() => document.activeElement === document.body);
  expect(focusIsBody).toBe(false);
});

test("a skip link lets a keyboard user bypass the nav straight to the main content", async ({ page }) => {
  await page.goto("/");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab"); // the skip link is the very first focusable element on the page
  const skipLink = page.locator(".skip-link");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toContainText("Skip to main content");
  await page.keyboard.press("Enter");
  const mainContentFocused = await page.evaluate(() => document.activeElement?.id === "main-content" || document.getElementById("main-content")?.contains(document.activeElement));
  expect(mainContentFocused).toBeTruthy();
});

test("the order preview button is reachable and operable by keyboard once signed in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await tabToButtonNamed(page, "Preview order");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notice")).toContainText("preview", { timeout: 10_000 });
});
