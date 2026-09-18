import { test, expect } from "@playwright/test";

// The mock market API server (tests/browser/mock-market-api-server.mjs)
// serves the snapshot REST endpoint but does not implement a WebSocket
// upgrade for /v1/markets/:symbol/stream -- exercising the real per-domain
// sequence-gap machinery end to end would need a real WS mock, which is out
// of scope here. What IS worth verifying in a real browser is the other
// half of the "reconnect detection and recovery" behavior (item 4): when
// the stream is genuinely unreachable, the UI settles on an honest
// "unavailable" status rather than retrying forever or silently pretending
// to be live. lib/sequence-recovery.test.ts covers the gap/duplicate/
// out-of-order classification itself in full.
test("market event stream gives up and reports unavailable after repeated reconnect failures, rather than retrying forever", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.locator(".panel-title", { hasText: "Recent market events" }).locator("span")).toHaveText("unavailable", { timeout: 20_000 });
});
