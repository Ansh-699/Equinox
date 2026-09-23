/** Hand-maintained optional operational bindings not inferred from wrangler. */
interface Env {
  /** Market-maker bot keys (devnet; never the market authority). */
  MM_MAKER_KEYPAIR_JSON?: string;
  MM_TAKER_KEYPAIR_JSON?: string;
  MARKET_MAKER: DurableObjectNamespace<import("./market-maker").MarketMaker>;
  /** "on" enables the transaction-submitting keeper jobs in the scheduled handler. */
  KEEPER_ORCHESTRATION?: string;
  PYTH_PRO_FEED_ID?: string;
  PYTH_PRO_MIN_CHANNEL?: string;
}
