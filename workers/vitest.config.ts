import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      durableObjects: { MARKET_STREAM: { className: 'MarketStream', useSQLite: true } },
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./migrations'), INGESTION_TOKEN: 'test-only-ingestion',
        ENVIRONMENT: 'development', E2E_TEST_MODE: '1',
        RELAYER_SERVICE_TOKEN: 'test-only-relayer-service-token',
        RELAYER_KEYPAIR_JSON: JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7 + 1) % 256)),
        SOLANA_RPC_URL: 'https://equinox.test/rpc-unused-in-this-test',
      },
    },
  })],
  test: { include: ["src/**/*.test.ts"], setupFiles: ["./src/test-setup.ts"] },
});
