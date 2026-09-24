/** Hand-maintained optional operational bindings not inferred from wrangler. */
interface Env {
  /** Market-maker bot keys (devnet; never the market authority). */
  /** services/market-maker's status endpoint, e.g. http://<vm-ip>:8080/v1/mm/status. */
  MM_STATUS_URL?: string;
  /** "on" enables the transaction-submitting keeper jobs in the scheduled handler. */
  KEEPER_ORCHESTRATION?: string;
  PYTH_PRO_FEED_ID?: string;
  PYTH_PRO_MIN_CHANNEL?: string;
}
