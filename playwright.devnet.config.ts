import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 4175;
const CORE = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
const MARKET_API = "https://stockstream-market-api.ansht.workers.dev";

if (process.env.RUN_DEVNET_E2E !== "1") {
  throw new Error("Devnet browser E2E is opt-in; run npm run test:browser:devnet");
}

/** Opt-in only: this config never starts against a fixture RPC or relayer. */
export default defineConfig({
  testDir: "./tests/browser-devnet",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${APP_PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `npx next dev -p ${APP_PORT}`,
    url: `http://127.0.0.1:${APP_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com",
      NEXT_PUBLIC_STOCKSTREAM_MARKET_ADDRESS: CORE,
      NEXT_PUBLIC_STOCKSTREAM_MARKET_SYMBOL: "AAPL-PERP",
      NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL: MARKET_API,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
