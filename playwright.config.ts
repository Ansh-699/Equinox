import { defineConfig, devices } from "@playwright/test";

const MOCK_RPC_PORT = 4181;
const MOCK_RELAYER_PORT = 4182;
const MOCK_MARKET_API_PORT = 4183;
const MOCK_RELAYER_TOKEN = "mock-relayer-token";
const APP_PORT = 4173;
// The fixture suite exercises the same V3 write branches as production. The
// mock RPC serves valid V3 core/shard bytes for this deterministic address;
// Devnet keeps its own separate opt-in configuration.
const V3_CORE_ADDRESS = "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node tests/browser/mock-rpc-server.mjs`,
      port: MOCK_RPC_PORT,
      reuseExistingServer: false,
        env: { MOCK_RPC_PORT: String(MOCK_RPC_PORT), MOCK_V3_CORE_ADDRESS: V3_CORE_ADDRESS },
    },
    {
      command: `node tests/browser/mock-relayer-server.mjs`,
      port: MOCK_RELAYER_PORT,
      reuseExistingServer: false,
      env: { MOCK_RELAYER_PORT: String(MOCK_RELAYER_PORT), MOCK_RELAYER_TOKEN },
    },
    {
      command: `node tests/browser/mock-market-api-server.mjs`,
      port: MOCK_MARKET_API_PORT,
      reuseExistingServer: false,
      env: { MOCK_MARKET_API_PORT: String(MOCK_MARKET_API_PORT) },
    },
    {
      // Dev mode, not a production build+start: NEXT_PUBLIC_E2E_TEST_MODE's
      // server-side auth bypass (lib/auth/e2e-test-mode.ts) requires
      // NODE_ENV !== "production", so the fake-wallet/injected-signature
      // test-mode shim this whole fixture suite depends on cannot run
      // against a real production server. This dev-mode choice is about
      // the auth bypass.
      command: "npm run dev:e2e",
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NEXT_PUBLIC_E2E_TEST_MODE: "1",
        NEXT_PUBLIC_SOLANA_RPC_URL: `http://127.0.0.1:${MOCK_RPC_PORT}`,
        NEXT_PUBLIC_EQUINOX_MARKET_API_URL: `http://127.0.0.1:${MOCK_MARKET_API_PORT}`,
        // Distinct from the program ID and from each other -- web3.js
        // rejects a message where the same address is both "invoked" (the
        // program) and "writable" (an account), which a shared placeholder
        // address here would trigger for real.
        NEXT_PUBLIC_EQUINOX_MARKET_ADDRESS: "62xct4vApqbZ8kRmdEb81ySog5twe6nfHJXph3Zap5Ps",
        NEXT_PUBLIC_EQUINOX_SETTLEMENT_SCRATCH_ADDRESS: "nKPxDByskqZr33kj4tnQTMHms8ms6h5pKXuQRBVY1rU",
        NEXT_PUBLIC_EQUINOX_COLLATERAL_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        NEXT_PUBLIC_EQUINOX_TOKEN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        NEXT_PUBLIC_EQUINOX_VAULT: "2c1xQXN8stTMFgNg1SXg11xPNUJTFgnGrvTwrvpH77hm",
        NEXT_PUBLIC_EQUINOX_VAULT_AUTHORITY: "GjBKKDieg7J8H73Yg9Zd2xwVD7htRqppmhAWwDcV4esK",
        NEXT_PUBLIC_EQUINOX_RELAYER_ADDRESS: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS: V3_CORE_ADDRESS,
        // The mock RPC has no Devnet lookup table; fixture transactions stay table-free.
        NEXT_PUBLIC_EQUINOX_LOOKUP_TABLE: "",
        NEXT_PUBLIC_EQUINOX_ORACLE_SNAPSHOT: "",
        EQUINOX_RELAYER_URL: `http://127.0.0.1:${MOCK_RELAYER_PORT}`,
        EQUINOX_RELAYER_TOKEN: MOCK_RELAYER_TOKEN,
      },
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
  ],
});
