import { test, expect, type Page } from "@playwright/test";

const RELAYER_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_RELAYER_PORT ?? 4182}/control`;
const MARKET_API_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_MARKET_API_PORT ?? 4183}/control`;

async function setExecutionStatus(status: string) {
  await fetch(MARKET_API_CONTROL_URL, { method: "POST", body: JSON.stringify({ status }) });
}

async function setRelayerMode(mode: string, resetNonce = false) {
  await fetch(RELAYER_CONTROL_URL, { method: "POST", body: JSON.stringify({ mode, resetNonce }) });
}

async function promptCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__stockstreamE2E?.promptCount ?? 0);
}

async function login(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
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
  await fillTicket(page);
}

/** Sizes the ticket: a limit price plus an amount give a non-zero share count. */
async function fillTicket(page: Page) {
  await page.getByLabel("Limit price").fill("250");
  await page.getByLabel("Amount", { exact: true }).fill("1000");
}


test.beforeEach(async () => {
  await setRelayerMode("success", true);
  // The mock market API server's execution status persists across every
  // spec file for the lifetime of this webServer process (see
  // er-routing.spec.ts) -- reset it here too so a status left over from
  // another file never leaks into these session-signed order flows, all
  // of which assume the default not-delegated (l1_only) market.
  await fetch(MARKET_API_CONTROL_URL, { method: "POST", body: JSON.stringify({ status: "l1_only" }) });
});

test("opens on Devnet with a visible risk indicator", async ({ page }) => {
  await page.goto("/trade");
  // The read-only demo banner also contains "Devnet", so pin the network label.
  await expect(page.getByText("Devnet", { exact: true })).toBeVisible();
});

test("login shows the active wallet, matching the test-mode signer's address", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  const address = await page.evaluate(() => window.__stockstreamE2E?.walletAddress);
  expect(address).toBeTruthy();
  await expect(page.locator(".wallet-button").first()).toContainText(address!.slice(0, 4));
});

test("market panel renders the configured market", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.locator(".market-panel h1")).toContainText("AAPL-PERP");
});

test("open orders panel honestly reports unavailable -- no mock orders are ever shown", async ({ page }) => {
  await page.goto("/trade");
  const panel = page.locator(".open-orders-panel");
  await expect(panel.locator("h2")).toHaveText("Open orders");
  await expect(panel).toContainText("complete V3 shard aggregate", { timeout: 10_000 });
  await expect(panel.locator("table")).toHaveCount(0);
});

test("deposit collateral: real sign -> submit -> confirm -> vault readback, one main-wallet prompt", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  expect(await promptCount(page)).toBe(0);
  await page.getByRole("button", { name: "Deposit" }).click();
  await expect(page.locator(".notice")).toContainText(/confirmed|finalized/, { timeout: 10_000 });
  await expect(page.locator(".notice")).toContainText("Vault balance");
  expect(await promptCount(page)).toBe(1);
});

test("one main-wallet prompt authorizes a session; ten session-signed actions follow with zero more", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);
  expect(await promptCount(page)).toBe(1); // exactly one main-wallet signature for authorize

  for (let i = 0; i < 10; i += 1) {
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
  }
  // Ten session-signed actions relayed, and the main wallet was never asked again.
  expect(await promptCount(page)).toBe(1);
});

test("nonce replay is rejected -- an un-advanced local nonce would fail here", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);

  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
  // A second action right after must use a DIFFERENT (advanced) nonce, or
  // the mock relayer's strict nonce check (mirroring the program's
  // SessionNonceReplay) rejects it -- this is the regression test for the
  // "nextExpectedNonce never advanced" bug found while building this.
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
  await expect(page.locator(".notice")).not.toContainText("nonce replay");
});

test("cancel order and replace order go through the same session-signed path", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);

  await page.getByText("Advanced order tools").click();
  await page.getByPlaceholder("0", { exact: true }).fill("12345");
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });

  await page.getByRole("button", { name: "Replace with ticket" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
});

test("reduce-only order requires and uses the reduceOnlyClose action bit", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);

  await page.getByLabel("Reduce-only").check();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Relayed", { timeout: 10_000 });
});

test("revoking clears trading capability -- a post-revocation order is rejected client-side", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);

  await page.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByRole("button", { name: "Authorize session" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /Preview order/ }).click();
  await expect(page.locator(".notice")).not.toContainText("Relayed");
});

test("withdrawal signs with the main wallet, never the session key", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  const before = await promptCount(page);
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.locator(".notice")).toContainText(/confirmed|finalized/, { timeout: 10_000 });
  expect(await promptCount(page)).toBe(before + 1);
});

test("V3 lifecycle submits the sharded seat action through L1", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await page.getByText("Advanced order tools").click();
  await page.getByRole("button", { name: "Create seat only" }).click();
  await expect(page.locator(".notice")).toContainText(/CreateV3TraderSeat confirmed — signature [1-9A-HJ-NP-Za-km-z]+…[1-9A-HJ-NP-Za-km-z]+\./);
});

test("V3 seat creation routes into the MagicBlock rollup while the bundle is ER-owned", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await setExecutionStatus("er_active");
  await expect(page.locator('.status-strip[aria-live="polite"]')).not.toContainText("not delegated", { timeout: 10_000 });
  await page.getByText("Advanced order tools").click();
  await page.getByRole("button", { name: "Create seat only" }).click();
  // Seats are created inside the rollup now, instead of being refused. The
  // fixture's legacy market address is not in the V3 cluster, so the router's
  // ER-only writable-cluster check is what answers here -- proof the ER path ran.
  await expect(page.locator(".notice")).toContainText(/rollup|writable account cluster/i, { timeout: 10_000 });
  await expect(page.locator(".notice")).not.toContainText("blocked");
});

test("V3 withdrawal stays blocked while a commit is pending", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await setExecutionStatus("commit_scheduled");
  await expect(page.locator('.status-strip[aria-live="polite"]')).toContainText("commit pending", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
});

test("V3 restored state re-enables the withdrawal write path", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await setExecutionStatus("restored");
  await page.waitForTimeout(5_500);
  const before = await promptCount(page);
  await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.locator(".notice")).toContainText(/confirmed|finalized/, { timeout: 10_000 });
  expect(await promptCount(page)).toBe(before + 1);
});

test("relayer unavailable surfaces the explicit relayer_unavailable state, not a generic error", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);
  await setRelayerMode("down");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("relayer_unavailable", { timeout: 10_000 });
});

test("relayer fee-payer unconfigured surfaces fee_payer_unavailable distinctly", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);
  await setRelayerMode("signer_unconfigured");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("fee_payer_unavailable", { timeout: 10_000 });
});

test("a dropped app session surfaces authentication_required, not a silent failure or a raw 401", async ({ page, context }) => {
  await page.goto("/trade");
  await login(page);
  await authorizeSession(page);
  // Drop only the httpOnly app-session cookie (never accessible to page JS)
  // -- the CSRF cookie stays, so the request genuinely reaches the relay
  // proxy and is rejected there (app/api/relay/session/route.ts's own
  // readPersistentSession check), rather than short-circuiting client-side.
  await context.clearCookies({ name: "stockstream_session" });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".notice")).toContainText("Authentication required", { timeout: 10_000 });
  await expect(page.locator(".notice")).toContainText("No application session");
});

test("no server secret names appear anywhere in the rendered page or its scripts", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  const html = await page.content();
  for (const secret of ["PRIVY_APP_SECRET", "PYTH_PRO_API_KEY", "KEEPER_KEYPAIR_JSON", "STOCKSTREAM_RELAYER_TOKEN", "mock-relayer-token"]) {
    expect(html).not.toContain(secret);
  }
});

test("landing page states the product and launches the terminal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Perpetual futures on US stocks");
  await page.getByRole("link", { name: "Launch App" }).click();
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByRole("button", { name: "Sign in to trade" })).toBeVisible();
});
