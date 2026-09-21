/** Public, read-only demo facts. No credentials or signing material belong here. */
export const DEMO_V3_CORE_ADDRESS = "7gP2YAqf6TNMqfkDkSdjb2Y1peLzoXadBnzL2LDzhFei";
export const DEMO_PROGRAM_ID = "BY81jGEfzwuqGkJbyYaGBty5Pn6oZLfntYUFkV85XZfo";
export const DEMO_MARKET_API_URL = "https://stockstream-market-api.ansht.workers.dev";
export const DEMO_LOCAL_ARTIFACT_SHA256 = "c878d70b13864c6a8d51170a67129867e64484bec8395ae455fa3c6132014b97";
export const DEMO_DEPLOYED_ARTIFACT_SHA256 = "c878d70b13864c6a8d51170a67129867e64484bec8395ae455fa3c6132014b97";

export const publicV3Core = process.env.NEXT_PUBLIC_STOCKSTREAM_V3_CORE_ADDRESS ?? DEMO_V3_CORE_ADDRESS;
export const publicMarketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL ?? DEMO_MARKET_API_URL;
