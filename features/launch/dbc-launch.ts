import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import deployment from "@/config/stockstream-deployment.json";

/** Launches are priced in dollars: the quote token is StockStream's test USDC
 * (the same collateral the perps use), not SOL. Equity is priced in USD. */
export const QUOTE_MINT = new PublicKey(deployment.collateralMint);
export const QUOTE_DECIMALS = 6;
export const BASE_DECIMALS = 6;

/** Equity-tuned Meteora DBC launch presets. Market caps are in USD (test USDC). */
export interface LaunchPreset {
  id: "discovery" | "earnings" | "steady" | "devnet";
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
    initialMarketCap: 25_000, migrationMarketCap: 250_000, startingFeeBps: 500, endingFeeBps: 100, decayMinutes: 120, dynamicFee: true, lockedLiquidityPercentage: 50,
  },
  {
    id: "earnings", label: "Earnings window", blurb: "Launch around a catalyst: dynamic fees track volatility and the curve graduates faster.",
    initialMarketCap: 50_000, migrationMarketCap: 300_000, startingFeeBps: 300, endingFeeBps: 80, decayMinutes: 60, dynamicFee: true, lockedLiquidityPercentage: 30,
  },
  {
    id: "steady", label: "Steady pair", blurb: "Mature, liquid underlying: flat low fee and a higher graduation target, like a normal stock pair.",
    initialMarketCap: 100_000, migrationMarketCap: 1_000_000, startingFeeBps: 60, endingFeeBps: 60, decayMinutes: 0, dynamicFee: false, lockedLiquidityPercentage: 20,
  },
  {
    id: "devnet", label: "Quick graduate (devnet)", blurb: "Same mechanics at a devnet scale: graduates to DAMM v2 at a $2k market cap, reachable with faucet USDC.",
    initialMarketCap: 200, migrationMarketCap: 2_000, startingFeeBps: 100, endingFeeBps: 100, decayMinutes: 0, dynamicFee: false, lockedLiquidityPercentage: 50,
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

// Loaded on demand: the SDK pulls in Anchor, which only the launch flow needs.
const loadSdk = () => import("@meteora-ag/dynamic-bonding-curve-sdk");

/** The pool fields we read. The SDK's generated type nests them under
 * `poolState` while the decoded account is flat; accept either. */
interface PoolFields { config: PublicKey; creator: PublicKey; baseMint: PublicKey; sqrtPrice: BN; quoteReserve: BN; isMigrated: number | boolean }
async function fetchPool(connection: Connection, pool: PublicKey | string) {
  const sdk = await loadSdk();
  const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
  const raw = await client.state.getPool(pool);
  if (!raw) throw new Error("pool not found");
  const fields = ((raw as unknown as { poolState?: PoolFields }).poolState ?? raw) as unknown as PoolFields;
  return { sdk, client, raw, fields };
}

/** Builds the createConfigAndPool transaction (config + mint keypairs already
 * signed); the creator adds the final signature. */
export async function buildLaunchTransaction(connection: Connection, input: LaunchInput) {
  const sdk = await loadSdk();
  const { preset } = input;
  const curve = sdk.buildCurveWithMarketCap({
    token: {
      tokenType: sdk.TokenType.SPLToken, tokenBaseDecimal: sdk.TokenDecimal.SIX, tokenQuoteDecimal: sdk.TokenDecimal.SIX,
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
    config: config.publicKey, feeClaimer: input.creator, leftoverReceiver: input.creator, payer: input.creator, quoteMint: QUOTE_MINT,
    preCreatePoolParam: { name: input.name, symbol: input.symbol, uri: input.uri, poolCreator: input.creator, baseMint: baseMint.publicKey },
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = input.creator;
  transaction.recentBlockhash = blockhash;
  transaction.partialSign(config, baseMint);
  const pool = sdk.deriveDbcPoolAddress(QUOTE_MINT, baseMint.publicKey, config.publicKey);
  return { transaction, lastValidBlockHeight, config: config.publicKey, baseMint: baseMint.publicKey, pool };
}

/** A pool's live state in plain numbers. */
export interface PoolView {
  pool: string;
  baseMint: string;
  creator: string;
  /** USD per token. */
  price: number;
  marketCap: number;
  /** 0..1 of the quote needed to graduate. */
  progress: number;
  raisedUsd: number;
  thresholdUsd: number;
  graduated: boolean;
  /** The DAMM v2 pool the liquidity moved to (graduated pools only). */
  dammPool: string | null;
}

export async function readPool(connection: Connection, pool: PublicKey | string): Promise<PoolView> {
  const { sdk, client, fields: state } = await fetchPool(connection, pool);
  const [threshold, config] = await Promise.all([client.state.getPoolMigrationQuoteThreshold(pool), client.state.getPoolConfig(state.config)]);
  const dammConfig = config ? sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption] : undefined;
  const price = Number(sdk.getPriceFromSqrtPrice(state.sqrtPrice, sdk.TokenDecimal.SIX, sdk.TokenDecimal.SIX));
  const raised = Number(state.quoteReserve.toString()) / 10 ** QUOTE_DECIMALS;
  const thresholdUsd = Number(threshold.toString()) / 10 ** QUOTE_DECIMALS;
  return {
    pool: String(pool), baseMint: state.baseMint.toBase58(), creator: state.creator.toBase58(),
    price, marketCap: price * TOTAL_SUPPLY, raisedUsd: raised, thresholdUsd,
    progress: thresholdUsd > 0 ? Math.min(1, raised / thresholdUsd) : 0,
    graduated: Boolean(state.isMigrated),
    dammPool: state.isMigrated && dammConfig ? sdk.deriveDammV2PoolAddress(dammConfig, state.baseMint, QUOTE_MINT).toBase58() : null,
  };
}

/** Buy (USDC in) or sell (tokens in) on the curve; `slippageBps` guards the quote. */
export async function buildSwapTransaction(connection: Connection, input: { owner: PublicKey; pool: PublicKey; side: "buy" | "sell"; amount: number; slippageBps?: number }) {
  const { sdk, client, raw, fields: state } = await fetchPool(connection, input.pool);
  const config = await client.state.getPoolConfig(state.config);
  if (!config) throw new Error("pool config not found");
  const swapBaseForQuote = input.side === "sell";
  const amountIn = new BN(Math.floor(input.amount * 10 ** (swapBaseForQuote ? BASE_DECIMALS : QUOTE_DECIMALS)));
  // Partial fill: a buy that would run past graduation fills up to it and returns the rest.
  const quote = client.pool.swapQuote2({
    virtualPool: raw, config, swapBaseForQuote, swapMode: sdk.SwapMode.PartialFill, amountIn, slippageBps: input.slippageBps ?? 100, hasReferral: false,
    currentPoint: new BN(Math.floor(Date.now() / 1000)), eligibleForFirstSwapWithMinFee: false,
  });
  const transaction = await client.pool.swap2({ owner: input.owner, pool: input.pool, swapMode: sdk.SwapMode.PartialFill, amountIn, minimumAmountOut: quote.minimumAmountOut ?? new BN(0), swapBaseForQuote, referralTokenAccount: null, payer: input.owner });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = input.owner;
  transaction.recentBlockhash = blockhash;
  return { transaction, lastValidBlockHeight, expectedOut: Number(quote.outputAmount.toString()) / 10 ** (swapBaseForQuote ? QUOTE_DECIMALS : BASE_DECIMALS) };
}

/** Graduation: moves a completed curve's liquidity into a Meteora DAMM v2 pool
 * (permissionless; anyone may pay for it once the curve has hit its threshold). */
export async function buildGraduateTransaction(connection: Connection, input: { payer: PublicKey; pool: PublicKey }) {
  const { sdk, client, fields } = await fetchPool(connection, input.pool);
  const config = await client.state.getPoolConfig(fields.config);
  if (!config) throw new Error("pool config not found");
  // The DAMM v2 config for this curve's migration fee option.
  const dammConfig = sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw new Error(`no DAMM v2 config for fee option ${config.migrationFeeOption}`);
  const migration = await client.migration.migrateToDammV2({ payer: input.payer, pool: input.pool, dammConfig });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  migration.transaction.feePayer = input.payer;
  migration.transaction.recentBlockhash = blockhash;
  migration.transaction.partialSign(migration.firstPositionNftKeypair, migration.secondPositionNftKeypair);
  return { transaction: migration.transaction, lastValidBlockHeight, dammPool: sdk.deriveDammV2PoolAddress(dammConfig, fields.baseMint, QUOTE_MINT) };
}
