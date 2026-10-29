// Check without spending: the mainnet launchpad builds a USDC-priced Meteora
// DBC launch and asks the connected wallet (not the trading key) to sign it for
// solana:mainnet. The wallet's SOL balance is faked and the final send is
// intercepted, so nothing reaches mainnet.
// Run: SITE=https://equinox.ansht.workers.dev/launch/mainnet npx tsx scripts/e2e/launch-mainnet.mts
import { VersionedTransaction } from "@solana/web3.js";
import { launch } from "./harness.mts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const { page, wallet, prompts, chains, step, connect, close } = await launch();
let sent: string | null = null;
let faucetCalls = 0;
await page.route("https://solana-rpc.publicnode.com/**", async (route) => {
  const body = route.request().postDataJSON() as { id: number; method: string; params: unknown[] } | null;
  if (body?.method === "getBalance") return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: 1_000_000_000 } } });
  if (body?.method === "sendTransaction") { sent = body.params[0] as string; return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "intercepted by e2e" } } }); }
  return route.continue();
});
await page.route("**/v1/faucet", (route) => { faucetCalls += 1; return route.abort(); });
const symbol = `E2E${Math.floor(Math.random() * 9000 + 1000)}`;
try {
  await connect();
  await page.getByText("Launchpad · mainnet").waitFor();
  await page.getByRole("button", { name: "Create launch" }).click();
  if (await page.getByRole("radio", { name: /Quick graduate/ }).count()) throw new Error("devnet preset offered on mainnet");
  await page.getByLabel("Token name").fill(`E2E ${symbol}`);
  await page.getByLabel("Symbol").fill(symbol);
  const before = prompts.length;
  // Launch only acts once the wallet session is up: click until it reports back.
  const status = page.locator("p[role=status]");
  for (let attempt = 0; attempt < 20 && !(await status.count()); attempt += 1) {
    await page.getByRole("button", { name: `Launch ${symbol}` }).click({ timeout: 5_000 }).catch(() => undefined);
    await status.first().waitFor({ timeout: 2_000 }).catch(() => undefined);
  }
  await page.getByText(/intercepted by e2e/).waitFor({ timeout: 90_000 });
  if (!sent) throw new Error("no transaction reached the RPC");
  const tx = VersionedTransaction.deserialize(Buffer.from(sent, "base64"));
  const keys = tx.message.staticAccountKeys.map(String);
  const checks = {
    "one wallet prompt": prompts.slice(before).join() === "signTransaction",
    "signed for solana:mainnet": chains.at(-1) === "solana:mainnet",
    "wallet pays": keys[0] === wallet.publicKey.toBase58(),
    "all three signatures present": tx.signatures.length === 3 && tx.signatures.every((s) => s.some((b) => b !== 0)),
    "priced in USDC": keys.includes(USDC),
    "Meteora DBC": keys.includes(DBC),
    "no faucet": faucetCalls === 0,
  };
  step(JSON.stringify(checks));
  if (Object.values(checks).includes(false)) throw new Error("mainnet launch check failed");
  console.log("PASS launch-mainnet");
} finally {
  await page.screenshot({ path: "test-results/e2e-launch-mainnet.png", fullPage: true }).catch(() => undefined);
  await close();
}
