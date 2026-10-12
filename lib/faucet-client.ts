import type { AppAuth } from "@/components/auth-context";
import { publicMarketApiUrl } from "@/lib/demo-config";

export interface FaucetClaimResult { ok: boolean; message: string }

/** Claims devnet test funds for `address`: vouched by a Privy session when
 * there is one, otherwise by a short wallet-signed claim. */
export async function requestTestFunds(auth: Pick<AppAuth, "privyAuthenticated" | "getAccessToken" | "signMessage">, address: string): Promise<FaucetClaimResult> {
  if (!publicMarketApiUrl) return { ok: false, message: "Faucet unavailable." };
  const token = auth.privyAuthenticated ? await auth.getAccessToken() : null;
  let claim: Record<string, string> = { wallet: address };
  if (!token) {
    try {
      const message = `Equinox devnet faucet\nwallet: ${address}\nissued: ${Math.floor(Date.now() / 1000)}`;
      const signature = await auth.signMessage(address, new TextEncoder().encode(message));
      claim = { wallet: address, message, signature: btoa(String.fromCharCode(...signature)) };
    } catch (error) {
      return { ok: false, message: `No test funds sent: ${error instanceof Error ? error.message : String(error)}.` };
    }
  }
  const response = await fetch(`${publicMarketApiUrl.replace(/\/$/, "")}/v1/faucet`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(claim),
  }).catch(() => null);
  const body = await response?.json().catch(() => null) as { error?: string; sol?: boolean; retryAfterSeconds?: number } | null;
  if (response?.ok) return { ok: true, message: `Sent 1,000 test USDC${body?.sol ? " and 0.05 SOL" : ""} to your wallet.` };
  if (response?.status === 429 && body?.error === "already claimed today") {
    const hours = typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? Math.ceil(body.retryAfterSeconds / 3600) : null;
    const retry = hours === null ? "Try again 24 hours after the last claim." : `Try again in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
    return { ok: false, message: `This trading account has already claimed its daily test funds. ${retry} You can also transfer devnet test USDC to this account.` };
  }
  if (response?.status === 429) return { ok: false, message: "The faucet is rate limited. Wait a minute and try again." };
  return { ok: false, message: `No test funds sent: ${body?.error ?? "faucet unavailable"}.` };
}

export async function claimTestFunds(auth: Pick<AppAuth, "privyAuthenticated" | "getAccessToken" | "signMessage">, address: string): Promise<string> {
  return (await requestTestFunds(auth, address)).message;
}
