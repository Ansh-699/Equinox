import { test, expect } from "@playwright/test";

/**
 * Runs against a real `next build && next start` server (see
 * playwright.production.config.ts), not `next dev`. This is intentionally
 * a SMOKE test, not a functional one: NEXT_PUBLIC_E2E_TEST_MODE requires
 * NODE_ENV !== "production", so the injectable test-wallet auth shim
 * (components/test-auth-provider.tsx) cannot run here at all -- there is
 * no way to log in or exercise trading in this config. What this DOES
 * prove, for real, against the actual production artifact: the server
 * boots, every top-level route renders real content with a 200, and no
 * server secret name leaks into the shipped HTML/scripts.
 */
const ROUTES = ["/", "/activity", "/portfolio", "/settings"];

for (const route of ROUTES) {
  test(`${route} returns 200 and renders real content on the production server`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator(".topbar .network")).toContainText("Devnet");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });
}

test("diagnostics is dev-only: no nav link, and the route itself refuses to render in production", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Diagnostics" })).toHaveCount(0);

  await page.goto("/diagnostics");
  await expect(page.getByText("Diagnostics is development-only.")).toBeVisible();
});

test("no server secret names appear in the production HTML or shipped scripts", async ({ page }) => {
  await page.goto("/");
  const html = await page.content();
  for (const secret of ["PRIVY_APP_SECRET", "PYTH_PRO_API_KEY", "KEEPER_KEYPAIR_JSON", "STOCKSTREAM_RELAYER_TOKEN"]) {
    expect(html).not.toContain(secret);
  }
});
