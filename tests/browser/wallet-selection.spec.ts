import { test, expect, type Page } from "@playwright/test";

const RELAYER_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_RELAYER_PORT ?? 4182}/control`;

test.beforeEach(async () => {
  await fetch(RELAYER_CONTROL_URL, { method: "POST", body: JSON.stringify({ mode: "success", resetNonce: true }) });
});

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
}

test("multiple wallets: nothing signs until one is explicitly chosen", async ({ page }) => {
  await page.goto("/trade?e2eWallets=2");
  await signIn(page);

  // Fail closed: the top bar must never show a wallet address here -- it
  // shows the distinct "choose a wallet" affordance instead.
  await expect(page.getByRole("button", { name: /Choose wallet \(2\)/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".wallet-button").first()).not.toContainText("...");

  // Choosing happens in the wallet drawer, not on a separate page.
  await page.getByRole("button", { name: /Choose wallet/ }).click();
  await expect(page.getByRole("dialog").getByRole("radiogroup", { name: "Active wallet" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByText("Multiple wallets are connected")).toBeVisible();
});

test("selecting a wallet activates it immediately and labels embedded vs external", async ({ page }) => {
  await page.goto("/settings?e2eWallets=2");
  await signIn(page);

  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(2, { timeout: 10_000 });
  await expect(radios.first()).toContainText("e2e-test-embedded");
  await expect(radios.nth(1)).toContainText("e2e-test-external");

  await radios.first().click();
  await expect(radios.first()).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });
});

test("switching the active wallet clears an authorized session immediately", async ({ page }) => {
  await page.goto("/settings?e2eWallets=2");
  await signIn(page);

  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(2, { timeout: 10_000 });
  await radios.first().click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });

  await page.getByRole("link", { name: "Trade", exact: true }).click();
  await page.getByRole("button", { name: "Authorize session" }).click();
  await expect(page.getByRole("button", { name: "Revoke session" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(radios.nth(1)).toBeVisible({ timeout: 10_000 });
  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");

  // The session belonged to wallet A -- switching to wallet B must show "no
  // session" immediately, not the old wallet's authorized session.
  const sessionStatus = page.getByTestId("session-status");
  await expect(sessionStatus).toHaveText("none");

  // And trading with the new wallet must go through a fresh authorization,
  // not the old session's key.
  await page.getByRole("link", { name: "Trade", exact: true }).click();
  await expect(page.getByRole("button", { name: "Authorize session" })).toBeVisible();
});

test("a persisted wallet selection restores after reload, but only if still connected", async ({ page }) => {
  await page.goto("/settings?e2eWallets=2");
  await signIn(page);
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(2, { timeout: 10_000 });
  await radios.nth(1).click();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  const selectedAddress = await page.evaluate(() => window.__equinoxE2E?.walletAddresses?.[1]);

  await page.reload();
  await signIn(page);
  await expect(page.getByRole("radio")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".wallet-button").first()).toContainText(selectedAddress!.slice(0, 4));
});

test("logging out clears the active wallet selection", async ({ page }) => {
  await page.goto("/settings?e2eWallets=2");
  await signIn(page);
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(2, { timeout: 10_000 });
  await radios.first().click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });

  await page.locator(".wallet-chip").click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible({ timeout: 10_000 });

  // Logging back in must never silently reuse the old selection as an
  // implicit wallets[0] pick -- it goes back to the fail-closed state.
  await signIn(page);
  await expect(page.getByRole("button", { name: /Choose wallet \(2\)/ })).toBeVisible({ timeout: 10_000 });
});
