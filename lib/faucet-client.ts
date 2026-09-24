import type { AppAuth } from "@/components/auth-context";
import { publicMarketApiUrl } from "@/lib/demo-config";

/** Claims devnet test funds for `address`: vouched by a Privy session when
 * there is one, otherwise by a short wallet-signed claim. Returns a user message. */
export async function claimTestFunds(auth: Pick<AppAuth, "privyAuthenticated" | "getAccessToken" | "signMessage">, address: string): Promise<string> {
  if (!publicMarketApiUrl) return "Faucet unavailable.";
  const token = auth.privyAuthenticated ? await auth.getAccessToken() : null;
  let claim: Record<string, string> = { wallet: address };
  if (!token) {
    try {
      const message = `Equinox devnet faucet\nwallet: ${address}\nissued: ${Math.floor(Date.now() / 1000)}`;
      const signature = await auth.signMessage(address, new TextEncoder().encode(message));
      claim = { wallet: address, message, signature: btoa(String.fromCharCode(...signature)) };
    } catch (error) {
      return `No test funds sent: ${error instanceof Error ? error.message : String(error)}.`;
    }
  }
  const response = await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/faucet`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(claim),
  }).catch(() => null);
  const body = await response?.json().catch(() => null) as { error?: string; sol?: boolean } | null;
  return response?.ok ? `Sent 1,000 test USDC${body?.sol ? " and 0.05 SOL" : ""} to your wallet.` : `No test funds sent: ${body?.error ?? "faucet unavailable"}.`;
}
