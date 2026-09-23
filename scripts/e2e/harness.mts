// Shared harness for the live production checks: a real Chrome page with a
// brand-new keypair injected as a Wallet Standard wallet. Signing happens in
// Node, and every wallet prompt is counted.
import { chromium, type Page } from "playwright";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createKeyPairFromPrivateKeyBytes, signBytes } from "@solana/kit";

export const SITE = process.env.SITE ?? "https://stockstream.ansht.workers.dev/trade";
const L1 = new Connection("https://api.devnet.solana.com", "confirmed");
const MINT = new PublicKey("GLgZYwSXmDTktcX9Hpizak7AjPJjd5QdwrRDkYc5oRtC");

export async function launch() {
  const wallet = Keypair.generate();
  const signingKey = await createKeyPairFromPrivateKeyBytes(wallet.secretKey.slice(0, 32));
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const prompts: string[] = [];
  await page.exposeFunction("__e2eSignMessage", async (bytes: number[]) => { prompts.push("signMessage"); return Array.from(new Uint8Array(await signBytes(signingKey.privateKey, Uint8Array.from(bytes)))); });
  await page.exposeFunction("__e2eSignTx", (bytes: number[]) => { prompts.push("signTransaction"); const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes)); tx.sign([wallet]); return Array.from(tx.serialize()); });
  await page.addInitScript("globalThis.__name = (f) => f;"); // tsx helper leaking into the serialized script
  await page.addInitScript(({ address, pk }) => {
    const account = { address, publicKey: Uint8Array.from(pk), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
    const w = window as unknown as Record<string, (b: number[]) => Promise<number[]>>;
    const injected = {
      version: "1.0.0", name: "E2E Wallet", chains: ["solana:devnet"], accounts: [account],
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => undefined },
        "standard:events": { version: "1.0.0", on: () => () => undefined },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: Uint8Array.from(await w.__e2eSignMessage(Array.from(i.message))) }))) },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedTransaction: Uint8Array.from(await w.__e2eSignTx(Array.from(i.transaction))) }))) },
      },
    };
    const register = (api: { register: (w: unknown) => void }) => api.register(injected);
    window.addEventListener("wallet-standard:app-ready", (event) => register((event as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  }, { address: wallet.publicKey.toBase58(), pk: Array.from(wallet.publicKey.toBytes()) });
  page.on("pageerror", (error) => console.log("pageerror", error.message));

  const t0 = Date.now();
  const step = (label: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
  const notice = async () => (await page.locator(".notice span").first().innerText().catch(() => "")).trim();
  let lastNotice = "";
  const watcher = setInterval(async () => { const n = await notice(); if (n && n !== lastNotice) { lastNotice = n; step(`  notice: ${n}`); } }, 250);
  /** Waits until the status line matches `pattern`; fails fast on a known failure message. */
  const waitNotice = async (pattern: RegExp, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = await notice();
      if (pattern.test(n)) return n;
      if (/not completed|failed|blocked|not placed/i.test(n)) throw new Error(`failed: ${n}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; last: ${n}`);
      await page.waitForTimeout(200);
    }
  };
  const connect = async (page: Page) => {
    await page.goto(SITE, { waitUntil: "load" });
    // Clicks before hydration do nothing: retry until the wallet list opens.
    const option = page.getByRole("button", { name: /E2E Wallet/ });
    for (let attempt = 0; attempt < 20 && !(await option.isVisible()); attempt += 1) {
      await page.getByRole("button", { name: /connect wallet/i }).first().click({ timeout: 30_000 });
      await option.waitFor({ timeout: 1_500 }).catch(() => undefined);
    }
    await option.click();
    step(`connected ${wallet.publicKey.toBase58()}`);
  };
  const walletUsdc = async () => (await L1.getTokenAccountBalance(getAssociatedTokenAddressSync(MINT, wallet.publicKey)).catch(() => null))?.value.uiAmountString ?? "0";
  const close = async () => { clearInterval(watcher); await browser.close(); };
  return { page, wallet, prompts, step, notice, waitNotice, connect: () => connect(page), walletUsdc, close };
}
