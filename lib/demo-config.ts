/** Public, read-only demo facts. No credentials or signing material belong here. */
export const DEMO_V3_CORE_ADDRESS = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
export const DEMO_PROGRAM_ID = "H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET";
export const DEMO_MARKET_API_URL = "https://stockstream-market-api.ansht.workers.dev";
export const DEMO_LOCAL_ARTIFACT_SHA256 = "69b7fb51b8562d6e41f946c4e5f106294cba4de58b62620020010c5dcd4ba4d0";
export const DEMO_DEPLOYED_ARTIFACT_SHA256 = "034b3088eeaf682c5c4618a2b704706eae177cd128d07a74f8365682bf15c0aa";

export const publicV3Core = process.env.NEXT_PUBLIC_STOCKSTREAM_V3_CORE_ADDRESS ?? DEMO_V3_CORE_ADDRESS;
export const publicMarketApiUrl = process.env.NEXT_PUBLIC_STOCKSTREAM_MARKET_API_URL ?? DEMO_MARKET_API_URL;
