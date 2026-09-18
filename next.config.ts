import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  // 127.0.0.1 is how the Playwright E2E suite reaches the dev server (see
  // playwright.config.ts); silences an otherwise-harmless HMR warning.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
