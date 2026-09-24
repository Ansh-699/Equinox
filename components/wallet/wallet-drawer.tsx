"use client";
/* eslint-disable @next/next/no-img-element -- wallet icons are data URIs from the extensions */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Droplets, LogOut, X } from "lucide-react";
import type { AppAuth } from "@/components/app-providers";
import { WalletSelector } from "@/features/wallet/wallet-selector";
import { refreshWalletBalances } from "@/features/portfolio/use-wallet-balances";
import type { AccountSummary } from "@/features/portfolio/use-account-summary";
import { AccountOverview, BalanceHero } from "@/features/account/account-overview";
import { PositionCard } from "@/features/account/position-card";
import { ActivityFeed } from "@/features/account/activity-list";
import { NetworkList } from "@/features/account/settings-list";
import { useMarketEvents } from "@/features/activity/use-market-events";
import { ThemeToggle } from "@/components/theme-toggle";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, SegmentedTabs } from "@/components/ui/primitives";
import { publicMarketApiUrl } from "@/lib/demo-config";
import { claimTestFunds } from "@/lib/faucet-client";

// Privy's own modal only for methods it can serve (email/Google); browser
// wallets connect directly in this drawer.
const PRIVY_MODAL_LOGIN = /email|google/.test(process.env.NEXT_PUBLIC_PRIVY_LOGIN_METHODS ?? "email,wallet");
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const TABS = [
  { id: "overview", label: "Overview", href: "/portfolio" },
  { id: "positions", label: "Positions", href: "/portfolio" },
  { id: "activity", label: "Activity", href: "/activity" },
  { id: "settings", label: "Settings", href: "/settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_KEY = "equinox:drawer-tab";

function readTab(): TabId {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.some((tab) => tab.id === stored) ? (stored as TabId) : "overview";
  } catch { return "overview"; }
}

/** Only mounted while the Activity tab is showing, so the drawer does not
 * hold a market socket open otherwise. */
function DrawerActivity() {
  const { events, status } = useMarketEvents(publicMarketApiUrl, "TSLA-PERP");
  return <ActivityFeed events={events} limit={10} emptyText={status === "unavailable" ? "Market events are unavailable right now." : "No market events yet."} />;
}

/** Slide-over account hub: connect (installed Solana wallets, one signature
 * via Privy SIWS), then the account: total balance, and Overview /
 * Positions / Activity / Settings tabs that each open their full page. */
export function WalletDrawer({ auth, open, onClose, summary }: { auth: AppAuth; open: boolean; onClose: () => void; summary: AccountSummary }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const address = auth.walletAddress;
  // Remembered per browser; read after mount (storage is client-only).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (open) setTab(readTab()); }, [open]);
  const chooseTab = (next: TabId) => {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* storage blocked */ }
  };
  const privyNote = auth.authError?.startsWith("Privy sign-in skipped") ? "Wallet connected · Privy linking unavailable" : null;
  const icon = auth.walletOptions.find((option) => option.name.toLowerCase() === auth.walletClientType)?.icon;

  // Focus into the panel on open; Escape closes.
  useEffect(() => {
    if (!open) return;
    (panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panelRef.current?.querySelector<HTMLElement>("button, a"))?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, address]);

  async function connect(name: string) {
    setConnecting(name);
    setError(null);
    try { await auth.connectWith(name); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setConnecting(null); }
  }

  async function claimFunds() {
    if (!address) return;
    setNotice("Sending test funds…");
    setNotice(await claimTestFunds(auth, address));
    refreshWalletBalances();
  }

  return (
    <div aria-hidden={!open} className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}>
      <div onClick={onClose} className={`absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={address ? "Account" : "Connect wallet"}
        className={`absolute right-0 top-0 flex h-full w-full max-w-[400px] flex-col border-l border-[var(--t-border)] bg-[var(--t-bg)] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {open ? (
          <>
            <div className="flex items-center justify-between px-5 pb-3 pt-5">
              {address ? (
                <div className="flex min-w-0 items-center gap-3">
                  {icon ? <img src={icon} alt="" className="h-9 w-9 rounded-[10px]" /> : <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--t-up-3)] text-[13px] font-bold text-white">{address.slice(0, 1)}</span>}
                  <div className="min-w-0">
                    <button type="button" onClick={() => void navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} className="flex items-center gap-1.5 font-mono text-[14px] font-semibold text-[var(--t-text)]" aria-label="Copy wallet address">
                      {short(address)} {copied ? <Check className="h-3.5 w-3.5 text-[var(--t-up)]" /> : <Copy className="h-3.5 w-3.5 text-[var(--t-text-3)]" />}
                    </button>
                    <div className="truncate text-[11.5px] text-[var(--t-text-3)]">{auth.privyAuthenticated ? `via Privy · ${auth.userLabel ?? auth.walletClientType ?? "wallet"}` : privyNote ?? `${auth.walletClientType ?? "wallet"} · connected`}</div>
                  </div>
                </div>
              ) : (
                <h2 className="text-[18px] font-semibold text-[var(--t-text)]">Connect Wallet</h2>
              )}
              <div className="flex items-center gap-1">
                {address || auth.wallets.length ? (
                  <button type="button" onClick={() => { void auth.logout(); onClose(); }} aria-label="Disconnect" title="Disconnect" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--t-text-3)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-down)]">
                    <LogOut className="h-4 w-4" />
                  </button>
                ) : null}
                <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-[8px] text-[var(--t-text-3)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="slim-scroll flex-1 overflow-y-auto px-5 pb-6">
              {!address ? (
                <>
                  {auth.wallets.length > 1 ? (
                    <section className="mb-5">
                      <h3 className="mb-2 text-[12px] text-[var(--t-text-3)]">Choose the wallet to trade with</h3>
                      <WalletSelector />
                    </section>
                  ) : null}
                  {auth.walletOptions.length ? (
                    <>
                      <h3 className="mb-2 text-[12px] text-[var(--t-text-3)]">Installed wallets</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {auth.walletOptions.map((option, index) => (
                          <button key={option.name} type="button" data-autofocus={index === 0 ? "" : undefined} disabled={!!connecting} onClick={() => void connect(option.name)}
                            className="flex h-[58px] items-center gap-3 rounded-[10px] border border-[var(--t-border)] bg-[var(--t-surface)] px-3 text-left text-[14px] text-[var(--t-text)] transition-colors hover:border-[var(--t-border-strong)] hover:bg-[var(--t-surface-3)] disabled:opacity-60">
                            <img src={option.icon} alt="" className="h-8 w-8 rounded-[8px]" />
                            <span className="truncate">{connecting === option.name ? "Connecting…" : option.name}</span>
                          </button>
                        ))}
                      </div>
                      <p className="mt-3 text-[11.5px] leading-snug text-[var(--t-text-3)]">Connecting asks your wallet to approve this site, then sign one message to link it to Privy. No transaction, no fee.</p>
                    </>
                  ) : (
                    <p className="text-[12.5px] leading-relaxed text-[var(--t-text-2)]">No Solana wallet extension found. Install <a className="text-[var(--t-link)] underline" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">Phantom</a> or <a className="text-[var(--t-link)] underline" href="https://solflare.com/download" target="_blank" rel="noopener noreferrer">Solflare</a>, or sign in with Privy.</p>
                  )}
                  {error ? <p role="alert" className="mt-3 break-words text-[12px] text-[var(--t-down)]">{error}</p> : null}
                  {PRIVY_MODAL_LOGIN ? <div className="mt-5 border-t border-[var(--t-border)] pt-4">
                    <button type="button" onClick={() => { auth.login(); onClose(); }} className="h-[38px] w-full rounded-[8px] border border-[var(--t-border-strong)] text-[13px] font-medium text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]">
                      Sign in
                    </button>
                    <p className="mt-2 text-[11px] text-[var(--t-text-3)]">Email and other Privy login methods</p>
                  </div> : (
                    <p className="mt-5 border-t border-[var(--t-border)] pt-4 text-[11px] text-[var(--t-text-3)]">New to Solana wallets? <a className="text-[var(--t-link)]" href="https://phantom.com/learn" target="_blank" rel="noopener noreferrer">Learn more ↗</a></p>
                  )}
                </>
              ) : (
                <>
                  <BalanceHero summary={summary} />
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => void claimFunds()} className={BUTTON_SECONDARY}><Droplets className="h-4 w-4" /> Get test USDC</button>
                    <Link href="/trade" onClick={onClose} className={BUTTON_PRIMARY}>Trade</Link>
                  </div>
                  {notice ? <p role="status" className="mt-2 text-[12px] text-[var(--t-text-2)]">{notice}</p> : null}

                  <SegmentedTabs className="mt-5" label="Account sections" tabs={TABS} value={tab} onChange={chooseTab} />
                  <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="mt-4">
                    {tab === "overview" ? <AccountOverview summary={summary} /> : null}
                    {tab === "positions" ? <PositionCard seat={summary.seat} compact /> : null}
                    {tab === "activity" ? <DrawerActivity /> : null}
                    {tab === "settings" ? (
                      <div className="space-y-4">
                        {auth.wallets.length > 1 ? (
                          <section>
                            <h3 className="mb-2 text-[12px] font-semibold text-[var(--t-text-2)]">Active wallet</h3>
                            <WalletSelector />
                          </section>
                        ) : null}
                        <section className="flex items-center justify-between rounded-[8px] border border-[var(--t-border)] px-3 py-2">
                          <span className="text-[12.5px] text-[var(--t-text)]">Theme</span>
                          <ThemeToggle />
                        </section>
                        <section>
                          <h3 className="mb-1 text-[12px] font-semibold text-[var(--t-text-2)]">Network</h3>
                          <NetworkList execution={summary.execution} />
                        </section>
                      </div>
                    ) : null}
                    <Link href={TABS.find((t) => t.id === tab)!.href} onClick={onClose} className="mt-4 flex items-center justify-end gap-1 text-[12.5px] font-medium text-[var(--t-link)] hover:underline">
                      Open full page <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
