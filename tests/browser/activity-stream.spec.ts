import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const rpc = (JSON.parse(readFileSync(new URL("../../config/equinox-deployment.json", import.meta.url), "utf8")) as { magicBlock: { rpc: string } }).magicBlock.rpc;

test("activity reports an unavailable rollup and offers a retry state", async ({ page }) => {
  await page.route(rpc, (route) => route.fulfill({ status: 503, body: "rollup unavailable" }));
  await page.goto("/activity");
  await expect(page.getByText("The rollup is unreachable right now; retrying.")).toBeVisible();
  await expect(page.getByText("unavailable", { exact: true })).toBeVisible();
});

test("activity reads all market event shards and exposes market filters", async ({ page }) => {
  let shardReads = 0;
  await page.route(rpc, async (route) => {
    const request = route.request().postDataJSON() as { method?: string; params?: [string[]] };
    if (request.method !== "getMultipleAccounts" || request.params?.[0]?.length !== 16) {
      await route.continue();
      return;
    }
    shardReads += 1;
    await route.fulfill({ json: { jsonrpc: "2.0", id: 1, result: { value: Array(16).fill(null) } } });
  });
  await page.goto("/activity");
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  expect(shardReads).toBeGreaterThan(0);
  await page.getByRole("button", { name: "OPENAI" }).click();
  await expect(page.getByRole("button", { name: "OPENAI" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Waiting for fills…")).toBeVisible();
});
