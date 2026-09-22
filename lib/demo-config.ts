/** Public, read-only demo facts. No credentials or signing material belong here. */
import deployment from "@/config/stockstream-deployment.json";

// No fresh market is currently safe to expose: the previous fresh core had a
// zero collateral mint and is intentionally abandoned. A market address must
// be supplied explicitly once a corrected fresh market is created.
export const DEMO_V3_CORE_ADDRESS = deployment.core ?? "";
export const DEMO_PROGRAM_ID = deployment.programId;
export const DEMO_MARKET_API_URL = "https://stockstream-market-api.ansht.workers.dev";
export const DEMO_LOCAL_ARTIFACT_SHA256: string = deployment.localArtifactSha256;
export const DEMO_DEPLOYED_ARTIFACT_SHA256: string = deployment.deployedArtifactSha256;

export const publicV3Core = process.env.NEXT_PUBLIC_STOCKSTREAM_V3_CORE_ADDRESS ?? DEMO_V3_CORE_ADDRESS;
export const publicMarketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL ?? DEMO_MARKET_API_URL;
