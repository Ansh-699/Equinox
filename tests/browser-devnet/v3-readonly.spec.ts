import { test, expect } from "@playwright/test";

const CORE = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
const MARKET_API = "https://stockstream-market-api.ansht.workers.dev";

test("loads the real Devnet terminal without exposing server credentials", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator(".topbar .network")).toContainText("Devnet");
  await expect(page.getByRole("combobox", { name: "Market" })).toHaveValue("AAPL-PERP");
  await expect(page.locator(".status-strip").filter({ hasText: "V3 bundle" }).getByText("unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const html = await page.content();
  for (const secret of ["PRIVY_APP_SECRET", "PYTH_PRO_API_KEY", "KEEPER_KEYPAIR_JSON", "STOCKSTREAM_RELAYER_TOKEN"]) {
    expect(html).not.toContain(secret);
  }
});

test("shows the live Worker V3 aggregate response honestly", async ({ page }) => {
  const response = await page.request.get(`${MARKET_API}/v1/v3/markets/${CORE}?domain=l1`);
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({ error: "v3_market_unavailable", domain: "l1" });
});
