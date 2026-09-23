import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    "dist/**",
    ".vinext/**",
    "node_modules/**",
    "coverage/**",
    "client/**",
    "keepers/**",
    "tests/**",
    "workers/**"
  ])
]);
