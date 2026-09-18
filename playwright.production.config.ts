import { defineConfig, devices } from "@playwright/test";

// Deliberately separate from playwright.config.ts: NEXT_PUBLIC_E2E_TEST_MODE
// requires NODE_ENV !== "production" server-side (lib/auth/e2e-test-mode.ts),
// so the test-mode auth shim (fake wallets, injected signatures) cannot run
// against a real production build/start at all. This config only proves the
// production server itself boots and serves real content -- no login, no
// session, no trading flow. See tests/browser-production/smoke.spec.ts and
// docs/frontend-build-diagnostics.md for the reproducibility investigation
// this complements.
const APP_PORT = 4174;

export default defineConfig({
  testDir: "./tests/browser-production",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npm run start -- -p ${APP_PORT}`,
    url: `http://127.0.0.1:${APP_PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
  ],
});
