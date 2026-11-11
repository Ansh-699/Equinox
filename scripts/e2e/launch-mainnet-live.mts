// SPENDS REAL SOL. Launches one token on mainnet through the live launchpad,
// buys $1 of it and sells it all back, signing with the keypair at
// WALLET_KEYPAIR. Each action is clicked once: a second launch click would pay
// the rent again. DRY=1 fakes the balance and intercepts the launch send.
// Run: WALLET_KEYPAIR=… NAME="…" SYMBOL=… SITE=https://equinox.ansht.workers.dev/launch/mainnet npx tsx scripts/e2e/launch-mainnet-live.mts
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { launch } from "./harness.mts";

const { WALLET_KEYPAIR, NAME, SYMBOL, DRY } = process.env;
if (!WALLET_KEYPAIR || !NAME || !SYMBOL || !/^[A-Z0-9]{2,10}$/.test(SYMBOL)) throw new Error("set WALLET_KEYPAIR, NAME and a 2-10 character SYMBOL");
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_KEYPAIR, "utf8"))));
const RPC = "https://solana-rpc.publicnode.com"; // the site's mainnet RPC, faked in DRY mode
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const l1 = new Connection("https://api.mainnet-beta.solana.com", "confirmed"); // PublicNode refuses token-balance reads

if (!DRY) {
  const sol = await l1.getBalance(keypair.publicKey);
  const usdc = Number((await l1.getTokenAccountBalance(getAssociatedTokenAddressSync(USDC, keypair.publicKey)).catch(() => null))?.value.uiAmount ?? 0);
  console.log(`wallet ${keypair.publicKey.toBase58()}: ${sol / 1e9} SOL, ${usdc} USDC`);
  const minSol = process.env.SKIP_LAUNCH ? 3_000_000 : 30_000_000; // a trade only opens one token account
  if (sol < minSol || usdc < 1) throw new Error(`need at least ${minSol / 1e9} SOL and 1 USDC`);
}

const { page, prompts, step, connect, close } = await launch(keypair);
if (DRY) {
  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postDataJSON() as { id: number; method: string; params: unknown[] } | null;
    if (body?.method === "getBalance") return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: 1_000_000_000 } } });
    if (body?.method === "sendTransaction") return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "intercepted by dry run" } } });
    return route.continue();
  });
}
const out: Record<string, string | null> = {};
const href = (name: string) => page.getByRole("link", { name }).first().getAttribute("href");
try {
  await connect();
  const address = keypair.publicKey.toBase58();
  await page.getByRole("button", { name: new RegExp(`^Account ${address.slice(0, 4)}\\.\\.\\.${address.slice(-4)}`) }).waitFor({ timeout: 60_000 });
  await page.getByText("Launchpad · mainnet").waitFor();
  // SKIP_LAUNCH=1 trades an already launched SYMBOL (e.g. after a launch landed but the page said otherwise).
  if (process.env.SKIP_LAUNCH) { if (DRY) throw new Error("SKIP_LAUNCH has nothing to dry-run"); }
  else {
  await page.getByRole("button", { name: "Create launch" }).click();
  await page.getByRole("radio", { name: /Steady pair/ }).click();
  await page.getByLabel("Token name").fill(NAME);
  await page.getByLabel("Symbol").fill(SYMBOL);

  // Click Launch until it takes, then never again: stop once the button goes
  // busy, the wallet is asked to sign, or an outcome shows.
  const outcome = page.getByText(new RegExp(`${SYMBOL} is live on mainnet|Not launched:`));
  const button = page.getByRole("button", { name: `Launch ${SYMBOL}` });
  const before = prompts.length;
  for (let attempt = 0; attempt < 20 && prompts.length === before && !(await outcome.count()); attempt += 1) {
    if (!(await button.isEnabled())) break;
    await button.click({ timeout: 1_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
  }
  await outcome.first().waitFor({ timeout: 120_000 });
  const text = await outcome.first().innerText();
  step(`${text} (wallet signed ${prompts.length - before}x)`);
  if (prompts.length - before !== 1) throw new Error("expected exactly one launch signature");
  if (DRY) { console.log(/intercepted by dry run/.test(await page.locator("body").innerText()) ? "PASS dry run: launch signed and stopped at send" : "FAIL dry run"); process.exitCode = 0; }
  else {
    if (!/is live/.test(text)) throw new Error(text);
    out.pool = await href("Pool ↗"); out.mint = await href("Token mint ↗"); out.launchTx = await href("Transaction ↗");
    await page.keyboard.press("Escape");
  }
  }
  if (!DRY) {

    const card = page.locator("article").filter({ has: page.getByLabel(`${SYMBOL} pool on the explorer`) });
    await card.waitFor({ timeout: 60_000 });
    const act = async (label: RegExp, click: () => Promise<void>) => {
      await click();
      const status = card.locator("p[role=status]");
      await status.filter({ hasText: /· done|failed|Connect a wallet/ }).waitFor({ timeout: 120_000 });
      const said = await status.innerText();
      step(said);
      if (!label.test(said)) throw new Error(said);
      return status.getByRole("link").getAttribute("href");
    };
    out.buyTx = await act(/Buying .* · done/, () => card.getByRole("button", { name: "$1" }).click());
    await page.waitForTimeout(3_000); // let the bought balance confirm before Sell all reads it
    out.sellTx = await act(/Selling .* · done/, () => card.getByRole("button", { name: "Sell all" }).click());
    console.log(JSON.stringify(out, null, 2));
  }
} finally {
  await page.screenshot({ path: "test-results/e2e-launch-mainnet-live.png", fullPage: true }).catch(() => undefined);
  await close();
}
