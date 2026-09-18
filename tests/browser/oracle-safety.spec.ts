import { test, expect } from "@playwright/test";

const MARKET_API_CONTROL_URL = `http://127.0.0.1:${process.env.MOCK_MARKET_API_PORT ?? 4183}/control`;

async function control(body: Record<string, unknown>): Promise<{ connectedSockets: number }> {
  const response = await fetch(MARKET_API_CONTROL_URL, { method: "POST", body: JSON.stringify(body) });
  return response.json();
}

async function waitForStreamConnected(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const { connectedSockets } = await control({});
    if (connectedSockets >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Mock market API server never saw a WebSocket connection");
}

// The mock RPC server's fixture market account (tests/browser/mock-rpc-
// server.mjs marketBytes()) sets oracleValid=true but
// lastVerifiedOracleTimestamp=1 (unix epoch second 1) -- deliberately
// ancient, so this is a real end-to-end check that the oracle safety
// banner (lib/oracle-safety.ts, wired into features/trading/trading-
// terminal.tsx) reads the real decoded account fields and classifies a
// stale timestamp as "stale", not "fresh".
test("oracle safety banner reads the real account header and shows 'stale' for an ancient verified timestamp", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".status-strip[aria-live='polite']")).toContainText("stale", { timeout: 10_000 });
});

// A real lifecycle event pushed over the market-event WebSocket hard-
// overrides the oracle-safety label regardless of the account's own
// (stale) timestamp -- proving the banner actually reads
// payload.kind from the live stream, not just the account header.
for (const [eventKind, expectedLabel] of [
  ["MarketPaused", "halted"],
  ["MarketClosed", "closed"],
  ["CorporateActionEntered", "corporate action"],
] as const) {
  test(`a live "${eventKind}" event flips the oracle safety banner to "${expectedLabel}"`, async ({ page }) => {
    await page.goto("/");
    await waitForStreamConnected();
    await control({ pushEvent: { id: eventKind, kind: "health", sequence: 1, domain: "l1", observedAt: Date.now(), payload: { kind: eventKind } } });
    await expect(page.locator(".status-strip[aria-live='polite']")).toContainText(expectedLabel, { timeout: 10_000 });
  });
}
