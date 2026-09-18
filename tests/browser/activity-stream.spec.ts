import { test, expect } from "@playwright/test";

const MARKET_API_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_MARKET_API_PORT ?? 4183}/control`;

async function control(body: Record<string, unknown>): Promise<{ connectedSockets: number; lastConnectionId: number }> {
  const response = await fetch(MARKET_API_CONTROL_URL, { method: "POST", body: JSON.stringify(body) });
  return response.json();
}

// A pushEvent sent before the page's WebSocket has actually connected is
// silently dropped (there is no socket to broadcast to yet) -- wait for a
// NEW connection specifically (lastConnectionId advancing past a captured
// baseline), not merely "connectedSockets >= 1": a stale page reconnecting
// (its own backoff racing this test's setup) can satisfy a bare count
// before this test's actual page connects, which silently pushes the
// event into the wrong socket.
async function waitForStreamConnected(afterConnectionId: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const { lastConnectionId } = await control({});
    if (lastConnectionId > afterConnectionId) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Mock market API server never saw a new WebSocket connection");
}

let connectionBaseline = 0;
test.beforeEach(async () => {
  const result = await control({ status: "l1_only", streamDown: false, resetSockets: true });
  connectionBaseline = result.lastConnectionId;
});

test("market event stream gives up and reports unavailable after repeated reconnect failures, rather than retrying forever", async ({ page }) => {
  await control({ streamDown: true });
  await page.goto("/activity");
  await expect(page.locator(".panel-title", { hasText: "Recent market events" }).locator("span")).toHaveText("unavailable", { timeout: 20_000 });
});

test("a sequence gap is detected, reported honestly, and triggers a resync -- never silently dropped or fabricated", async ({ page }) => {
  await page.goto("/activity");
  await waitForStreamConnected(connectionBaseline);

  // First event establishes the baseline cursor at sequence 1 and is what
  // actually flips the stream status to "live" (a snapshot alone never does).
  await control({ pushEvent: { id: "e1", kind: "fill", sequence: 1, domain: "l1", observedAt: Date.now() } });
  await expect(page.locator(".panel-title", { hasText: "Recent market events" }).locator("span")).toHaveText("live", { timeout: 10_000 });

  // Skips straight to 5 -- a real 3-event gap (2, 3, 4 never arrived).
  await control({ pushEvent: { id: "e2", kind: "fill", sequence: 5, domain: "l1", observedAt: Date.now() } });

  await expect(page.getByText(/sequence gap.*detected/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("missed events")).toBeVisible();
});

test("a duplicate/replayed event is dropped, not shown twice or treated as a gap", async ({ page }) => {
  await page.goto("/activity");
  await waitForStreamConnected(connectionBaseline);

  await control({ pushEvent: { id: "d1", kind: "fill", sequence: 10, domain: "l1", observedAt: Date.now() } });
  await expect(page.locator(".activity-table tbody tr")).toHaveCount(1, { timeout: 10_000 });
  await control({ pushEvent: { id: "d1-again", kind: "fill", sequence: 10, domain: "l1", observedAt: Date.now() } });

  await expect(page.getByText(/duplicate\/out-of-order event/)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".activity-table tbody tr")).toHaveCount(1);
});
