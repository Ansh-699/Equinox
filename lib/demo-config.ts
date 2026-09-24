/** Public, read-only demo facts. No credentials or signing material belong here. */
import deployment from "@/config/equinox-deployment.json";

// The manifest exposes only the Devnet market whose full L1/ER lifecycle was
// verified (docs/status/devnet-e2e-lifecycle-20260923.json).
export const DEMO_V3_CORE_ADDRESS = deployment.core ?? "";
export const DEMO_PROGRAM_ID = deployment.programId;
/** Per-market address lookup table; V3 custody transactions exceed the legacy size limit without it. */
export const DEMO_LOOKUP_TABLE: string = process.env.NEXT_PUBLIC_EQUINOX_LOOKUP_TABLE
  ?? (deployment as { lookupTable?: string | null }).lookupTable ?? "";
/** L1 OracleSnapshotV3 (authenticated Pyth price) read by the terminal. */
export const DEMO_ORACLE_SNAPSHOT: string = process.env.NEXT_PUBLIC_EQUINOX_ORACLE_SNAPSHOT
  ?? (deployment as { oracleSnapshot?: string | null }).oracleSnapshot ?? "";
export const DEMO_MARKET_API_URL = "https://stockstream-market-api.ansht.workers.dev";
export const DEMO_LOCAL_ARTIFACT_SHA256: string = deployment.localArtifactSha256;
export const DEMO_DEPLOYED_ARTIFACT_SHA256: string = deployment.deployedArtifactSha256;

export const publicV3Core = process.env.NEXT_PUBLIC_EQUINOX_V3_CORE_ADDRESS ?? DEMO_V3_CORE_ADDRESS;
export const publicMarketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL ?? DEMO_MARKET_API_URL;
