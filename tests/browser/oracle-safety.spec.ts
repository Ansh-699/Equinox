import { test, expect } from "@playwright/test";

// The mock RPC server's fixture market account (tests/browser/mock-rpc-
// server.mjs marketBytes()) sets oracleValid=true but
// lastVerifiedOracleTimestamp=1 (unix epoch second 1) -- deliberately
// ancient, so this is a real end-to-end check that the oracle safety
// banner (lib/oracle-safety.ts, wired into features/trading/trading-
// terminal.tsx) reads the real decoded account fields and classifies a
// stale timestamp as "stale", not "fresh". Exercising the other states
// (halted/closed/corp_action) would need the mock market-event stream to
// emit fake lifecycle events, which is out of scope here -- the full state
// table is covered by lib/oracle-safety.test.ts.
test("oracle safety banner reads the real account header and shows 'stale' for an ancient verified timestamp", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".status-strip[aria-live='polite']")).toContainText("stale", { timeout: 10_000 });
});
