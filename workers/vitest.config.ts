import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      durableObjects: { MARKET_STREAM: { className: 'MarketStream', useSQLite: true } },
      bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations'), INGESTION_TOKEN: 'test-only-ingestion' },
    },
  })],
  test: { include: ["src/**/*.test.ts"] },
});
