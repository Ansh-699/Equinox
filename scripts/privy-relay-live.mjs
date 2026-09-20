#!/usr/bin/env node
/**
 * Live Privy-linked-wallet relayer harness. It is intentionally inert unless
 * `--submit` is supplied: a successful relay consumes a TradingSession nonce
 * and may submit a transaction to Devnet. `--replay` repeats the identical
 * signed transaction with a fresh request id and requires the second request
 * to be rejected by the on-chain nonce check.
 *
 * Required server-only runtime values:
 *   PRIVY_ACCESS_TOKEN       fresh token from the linked-wallet browser flow
 *   PRIVY_EXPECTED_WALLET    public Solana wallet expected to be linked
 *   PRIVY_APP_ID or NEXT_PUBLIC_PRIVY_APP_ID, PRIVY_APP_SECRET
 *
 * Additional --submit values (all public except service token):
 *   STOCKSTREAM_RELAYER_URL, STOCKSTREAM_RELAYER_TOKEN,
 *   RELAY_TRANSACTION_BASE64, RELAY_SESSION_SIGNER,
 *   RELAY_EXPECTED_MARKET
 *
 * No secret or JWT is printed. Default mode proves the Privy identity and
 * wallet linkage only; it performs no relay request and sends no transaction.
 */

const token = process.env.PRIVY_ACCESS_TOKEN;
const expectedWallet = process.env.PRIVY_EXPECTED_WALLET;
const appId = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
if (!token || !expectedWallet || !appId || !appSecret) {
  console.error("Missing PRIVY_ACCESS_TOKEN, PRIVY_EXPECTED_WALLET, PRIVY_APP_ID/NEXT_PUBLIC_PRIVY_APP_ID, or PRIVY_APP_SECRET");
  process.exit(1);
}

const { PrivyClient } = await import("@privy-io/node");
const client = new PrivyClient({ appId, appSecret });
const verified = await client.utils().auth().verifyAccessToken(token).catch(() => null);
if (!verified?.user_id || verified.app_id !== appId) {
  console.error("Privy token verification failed or has the wrong audience");
  process.exit(1);
}
const user = await client.users()._get(verified.user_id).catch(() => null);
const linkedWallets = (user?.linked_accounts ?? [])
  .filter((account) => account?.chain_type === "solana" && typeof account.address === "string")
  .map((account) => account.address);
if (!linkedWallets.includes(expectedWallet)) {
  console.error("Privy identity does not have the expected Solana wallet linked");
  process.exit(1);
}
console.log("Privy linked-wallet preflight passed (token and identity redacted)");

const submit = process.argv.includes("--submit");
const replay = process.argv.includes("--replay");
if (!submit) {
  if (replay) {
    console.error("--replay requires --submit");
    process.exit(1);
  }
  console.log("No relay submitted. Add --submit only for an approved nonce-consuming Devnet transaction.");
  process.exit(0);
}

const url = process.env.STOCKSTREAM_RELAYER_URL;
const serviceToken = process.env.STOCKSTREAM_RELAYER_TOKEN;
const transactionBase64 = process.env.RELAY_TRANSACTION_BASE64;
const sessionSignerAddress = process.env.RELAY_SESSION_SIGNER;
const expectedMarket = process.env.RELAY_EXPECTED_MARKET;
if (!url || !serviceToken || !transactionBase64 || !sessionSignerAddress || !expectedMarket) {
  console.error("--submit requires relayer URL/token, transaction, session signer, and expected market runtime values");
  process.exit(1);
}
const relayBody = () => JSON.stringify({
  transactionBase64,
  sessionSignerAddress,
  ownerWallet: expectedWallet,
  expectedMarket,
  domain: process.env.RELAY_DOMAIN === "er" ? "er" : "l1",
  clientRequestId: crypto.randomUUID(),
});
const relay = () => fetch(new URL("/v1/relay/session", url), {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-stockstream-relayer-service-token": serviceToken,
  },
  body: relayBody(),
});
const response = await relay();
const body = await response.json().catch(() => null);
if (!response.ok || !body?.signature) {
  console.error(`Relay rejected: HTTP ${response.status}, code=${typeof body?.error === "string" ? body.error : "unknown"}`);
  process.exit(1);
}
console.log(`Relay accepted: signature=${body.signature}`);

if (replay) {
  const replayResponse = await relay();
  const replayBody = await replayResponse.json().catch(() => null);
  if (replayResponse.ok && replayBody?.signature) {
    console.error("Replay unexpectedly accepted: nonce protection failed");
    process.exit(1);
  }
  console.log(`Replay rejected as expected: HTTP ${replayResponse.status}, code=${typeof replayBody?.error === "string" ? replayBody.error : "unknown"}`);
}
