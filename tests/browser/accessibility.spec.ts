import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Automated accessibility scan (axe-core, WCAG 2.0/2.1 A+AA rulesets).
 * This catches machine-detectable violations (missing labels, contrast,
 * ARIA misuse, landmark structure) -- it does NOT establish WCAG
 * compliance on its own. axe-core itself documents that automated tooling
 * only catches a minority of real accessibility issues; the manual
 * checklist in docs/accessibility.md covers what this can't (keyboard
 * operability, focus order, screen-reader behavior, reduced motion).
 */
async function scan(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}

function formatViolations(violations: { id: string; help: string; nodes: { target: unknown[]; failureSummary?: string }[] }[]): string {
  return violations.map((v) => `${v.id} (${v.help}): ${v.nodes.length} node(s) -- e.g. ${JSON.stringify(v.nodes[0]?.target)}`).join("\n");
}

async function login(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await expect(page.locator(".wallet-button").first()).toContainText("...", { timeout: 10_000 });
}

test("trade page (signed out) has no automated accessibility violations", async ({ page }) => {
  await page.goto("/trade");
  const results = await scan(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});

test("trade page (signed in) has no automated accessibility violations", async ({ page }) => {
  await page.goto("/trade");
  await login(page);
  const results = await scan(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});

test("settings page has no automated accessibility violations", async ({ page }) => {
  await page.goto("/settings");
  const results = await scan(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});

test("activity page has no automated accessibility violations", async ({ page }) => {
  await page.goto("/activity");
  const results = await scan(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});

test("portfolio page has no automated accessibility violations", async ({ page }) => {
  await page.goto("/portfolio");
  const results = await scan(page);
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
});
