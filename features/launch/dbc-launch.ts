import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

/** Wrapped SOL: the launch quote token. */
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Equity-tuned Meteora DBC launch presets. Market caps are in the quote token (SOL). */
export interface LaunchPreset {
  id: "discovery" | "earnings" | "steady";
  label: string;
  blurb: string;
  initialMarketCap: number;
  migrationMarketCap: number;
  /** Launch fee decays linearly from start to end over `decayMinutes` (anti-snipe on day one). */
  startingFeeBps: number;
  endingFeeBps: number;
  decayMinutes: number;
  /** Volatility-scaled surcharge on top of the base fee. */
  dynamicFee: boolean;
  /** Share of graduated LP locked forever, so liquidity outlives the launch. */
  lockedLiquidityPercentage: number;
}

export const LAUNCH_PRESETS: readonly LaunchPreset[] = [
  {
    id: "discovery", label: "Price discovery", blurb: "Thin, newly tokenized equity: a long fee decay dampens opening-day volatility and 50% of graduated LP is locked.",
    initialMarketCap: 30, migrationMarketCap: 400, startingFeeBps: 500, endingFeeBps: 100, decayMinutes: 120, dynamicFee: true, lockedLiquidityPercentage: 50,
  },
  {
    id: "earnings", label: "Earnings window", blurb: "Launch around a catalyst: dynamic fees track volatility and the curve graduates faster.",
    initialMarketCap: 60, migrationMarketCap: 300, startingFeeBps: 300, endingFeeBps: 80, decayMinutes: 60, dynamicFee: true, lockedLiquidityPercentage: 30,
  },
  {
    id: "steady", label: "Steady pair", blurb: "Mature, liquid underlying: flat low fee and a higher graduation target, like a normal stock pair.",
    initialMarketCap: 100, migrationMarketCap: 1_000, startingFeeBps: 60, endingFeeBps: 60, decayMinutes: 0, dynamicFee: false, lockedLiquidityPercentage: 20,
  },
];

export const TOTAL_SUPPLY = 1_000_000_000;

/** What the curve implies, in plain numbers, before any SDK is loaded. */
export function describePreset(preset: LaunchPreset) {
  return {
    startPrice: preset.initialMarketCap / TOTAL_SUPPLY,
    graduationPrice: preset.migrationMarketCap / TOTAL_SUPPLY,
    priceMultiple: preset.migrationMarketCap / preset.initialMarketCap,
  };
}

export interface LaunchInput {
  name: string;
  symbol: string;
  uri: string;
  preset: LaunchPreset;
  creator: PublicKey;
}

/** Builds the createConfigAndPool transaction (config + mint keypairs already
 * signed); the creator's wallet adds the final signature. */
export async function buildLaunchTransaction(connection: Connection, input: LaunchInput) {
  // Loaded on demand: the SDK pulls in Anchor, which only the launch flow needs.
  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { preset } = input;
  const curve = sdk.buildCurveWithMarketCap({
    token: {
      tokenType: sdk.TokenType.SPLToken, tokenBaseDecimal: sdk.TokenDecimal.SIX, tokenQuoteDecimal: sdk.TokenDecimal.NINE,
      tokenAuthorityOption: sdk.TokenAuthorityOption.Immutable, totalTokenSupply: TOTAL_SUPPLY, leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: sdk.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: preset.startingFeeBps, endingFeeBps: preset.endingFeeBps,
          numberOfPeriod: preset.decayMinutes ? preset.decayMinutes : 0, totalDuration: preset.decayMinutes * 60,
        },
      },
      dynamicFeeEnabled: preset.dynamicFee, collectFeeMode: sdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50, poolCreationFee: 0, enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: sdk.MigrationOption.MET_DAMM_V2, migrationFeeOption: sdk.MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: sdk.MigratedCollectFeeMode.QuoteToken, dynamicFee: sdk.DammV2DynamicFeeMode.Enabled, poolFeeBps: Math.max(10, preset.endingFeeBps) },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 100 - preset.lockedLiquidityPercentage, creatorPermanentLockedLiquidityPercentage: preset.lockedLiquidityPercentage,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: sdk.ActivationType.Timestamp,
    initialMarketCap: preset.initialMarketCap,
    migrationMarketCap: preset.migrationMarketCap,
  });
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
  const transaction: Transaction = await client.partner.createConfigAndPool({
    ...curve,
    config: config.publicKey, feeClaimer: input.creator, leftoverReceiver: input.creator, payer: input.creator, quoteMint: NATIVE_MINT,
    preCreatePoolParam: { name: input.name, symbol: input.symbol, uri: input.uri, poolCreator: input.creator, baseMint: baseMint.publicKey },
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = input.creator;
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(config, baseMint);
  const pool = sdk.deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config.publicKey);
  return { transaction, lastValidBlockHeight, config: config.publicKey, baseMint: baseMint.publicKey, pool };
}
