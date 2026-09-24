"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { useAppAuth } from "@/components/app-providers";
import { WalletSelector } from "@/features/wallet/wallet-selector";
import { useEquinoxProtocol } from "@/features/wallet/use-equinox-protocol";
import { useTradingKey } from "@/features/wallet/use-trading-key";
import { useTradingSession } from "@/features/sessions/use-trading-session";
import { useExecutionStatus } from "@/features/magicblock/use-execution-status";
import { NetworkList } from "@/features/account/settings-list";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge, BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, Card, EmptyState, shortAddress } from "@/components/ui/primitives";
import { marketForSymbol } from "@/lib/markets";

const marketApiUrl = process.env.NEXT_PUBLIC_EQUINOX_MARKET_API_URL;

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-[var(--t-text)]">{label}</div>
        {hint ? <div className="text-[11.5px] text-[var(--t-text-3)]">{hint}</div> : null}
      </div>
      <div className="tnum min-w-0 text-right text-[12.5px] text-[var(--t-text-2)]">{children}</div>
    </div>
  );
}

function expiresIn(expiresAt: number, now: number): string {
  const seconds = expiresAt - Math.floor(now / 1000);
  if (seconds <= 0) return "expired";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
}

export function SettingsView() {
  const auth = useAppAuth();
  const marketSymbol = process.env.NEXT_PUBLIC_EQUINOX_MARKET_SYMBOL ?? "AAPL-PERP";
  const marketConfig = marketForSymbol(marketSymbol);
  const marketAddress = process.env.NEXT_PUBLIC_EQUINOX_MARKET_ADDRESS ?? marketConfig.marketPda;
  const protocol = useEquinoxProtocol(auth.authenticated ? marketAddress : null);
  const session = useTradingSession(protocol, auth.walletAddress, marketAddress, 0);
  const executionStatus = useExecutionStatus(marketApiUrl, marketSymbol);
  const tradingKey = useTradingKey(auth);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const icon = auth.walletOptions.find((option) => option.name.toLowerCase() === auth.walletClientType)?.icon;
  const sessionLabel = session.status ? (session.status.revoked ? "revoked" : "authorized") : "none";

  return (
    <div className="terminal min-h-screen">
      <TopBar active="settings" auth={auth} />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[880px] px-4 py-6 outline-none">
        <div className="mb-5">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--t-text)]">Settings</h1>
          <p className="mt-1 text-[13px] text-[var(--t-text-2)]">Your wallet, how trades get signed, and the services Equinox talks to.</p>
        </div>

        <div className="space-y-4">
          <Card title="Account" action={<Badge tone={auth.privyAuthenticated ? "up" : "muted"} dot>{auth.privyAuthenticated ? "Signed in" : "Not signed in"}</Badge>}>
            {auth.walletAddress ? (
              <div className="flex items-center gap-3 pb-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are extension data URIs */}
                {icon ? <img src={icon} alt="" className="h-10 w-10 rounded-[10px]" /> : <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-[var(--t-up-3)] text-[14px] font-bold text-[var(--t-on-fill)]">{auth.walletAddress.slice(0, 1)}</span>}
                <div className="min-w-0 flex-1">
                  <button type="button" aria-label="Copy wallet address" onClick={() => void navigator.clipboard?.writeText(auth.walletAddress!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
                    className="flex items-center gap-1.5 font-mono text-[14px] font-semibold text-[var(--t-text)]">
                    {shortAddress(auth.walletAddress)} {copied ? <Check className="h-3.5 w-3.5 text-[var(--t-up)]" /> : <Copy className="h-3.5 w-3.5 text-[var(--t-text-3)]" />}
                  </button>
                  <div className="text-[12px] capitalize text-[var(--t-text-3)]">{auth.walletClientType ?? "wallet"}{auth.userLabel ? ` · ${auth.userLabel}` : ""}</div>
                </div>
              </div>
            ) : (
              <p className="pb-2 text-[12.5px] leading-relaxed text-[var(--t-text-2)]">
                {auth.wallets.length > 0
                  ? auth.privyAuthenticated
                    ? "Choose a wallet below before trading."
                    : "A wallet is connected but the Privy sign-in did not finish. Finish sign-in, or disconnect and try again. (If this keeps happening, enable Solana wallet login in the Privy dashboard.)"
                  : "Sign in with Privy to see wallet details."}
              </p>
            )}
            <WalletSelector />
            {auth.wallets.length > 0 || auth.privyAuthenticated ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--t-border)] pt-3">
                {!auth.walletAddress && auth.wallets.length === 1 ? <button type="button" className={BUTTON_PRIMARY} onClick={auth.login}>Finish sign-in</button> : null}
                <button type="button" className={BUTTON_DANGER} onClick={() => void auth.logout()}>Disconnect wallet</button>
              </div>
            ) : null}
          </Card>

          <Card title="Trading" action={<Badge tone={sessionLabel === "authorized" ? "up" : sessionLabel === "revoked" ? "down" : "muted"}><span data-testid="session-status">{sessionLabel}</span></Badge>}>
            <div className="divide-y divide-[var(--t-border)]">
              <Row label="Instant trading" hint="An in-app trading account signs orders, deposits and withdrawals without wallet popups.">
                {tradingKey.signer?.address ? <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-[var(--t-up)]" /><span className="font-mono">{shortAddress(tradingKey.signer.address)}</span></span>
                  : <Link href="/trade" className="font-semibold text-[var(--t-link)] hover:underline">Enable on Trade →</Link>}
              </Row>
              {session.status ? (
                <>
                  <Row label="Session key" hint={`Market ${marketSymbol}`}><span className="font-mono" title={session.status.sessionSignerAddress}>{shortAddress(session.status.sessionSignerAddress)}</span></Row>
                  <Row label="Expires">{expiresIn(session.status.expiresAt, now)} <span className="text-[var(--t-text-3)]">({new Date(session.status.expiresAt * 1000).toLocaleString()})</span></Row>
                  <Row label="Max per order">{session.status.maxOrderNotional}</Row>
                  <Row label="Max total volume">{session.status.maxCumulativeNotional}</Row>
                  <Row label="Max exposure">{session.status.maximumExposure}</Row>
                  <Row label="Max open orders">{session.status.maximumOpenOrders}</Row>
                  <Row label="Next nonce">{session.status.nextExpectedNonce.toString()}</Row>
                </>
              ) : (
                <EmptyState icon={<KeyRound className="h-5 w-5" />} title="No trading session for this wallet">
                  A session lets a relayer submit capped orders for you. Authorize one from the Trade page.
                </EmptyState>
              )}
            </div>
            {session.status ? (
              <div className="mt-3 rounded-[8px] border border-[var(--t-down)] bg-[var(--t-down-soft)] p-3">
                <div className="text-[12px] font-semibold text-[var(--t-down)]">Danger zone</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={BUTTON_DANGER} disabled={session.pending} onClick={() => void session.revoke()}>{session.pending ? "Revoking…" : "Revoke session"}</button>
                  <button type="button" className={BUTTON_SECONDARY} onClick={() => { session.clearLocal(); setNotice("Local session key cleared. The on-chain session (if any) is untouched: revoke it separately if you want it invalidated."); }}>Clear local session</button>
                </div>
              </div>
            ) : null}
            {session.error ? <p className="mt-2 text-[12px] text-[var(--t-down)]">{session.error}</p> : null}
            {notice ? <p role="status" className="mt-2 text-[12px] text-[var(--t-text-2)]">{notice}</p> : null}
          </Card>

          <Card title="Preferences">
            <Row label="Theme" hint="Dark or light; remembered on this device."><ThemeToggle /></Row>
          </Card>

          <Card title="Network" action={<Badge tone="link">Devnet</Badge>} bodyClassName="px-4 py-1">
            <NetworkList execution={executionStatus} />
            <div className="border-t border-[var(--t-border)] py-2.5 text-right">
              <Link href="/diagnostics" className="text-[12.5px] font-medium text-[var(--t-link)] hover:underline">Open diagnostics →</Link>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
