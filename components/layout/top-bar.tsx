"use client";
/* eslint-disable @next/next/no-img-element -- wallet icons are extension data URIs */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Compass, Menu, Settings, WalletCards, X, Zap } from "lucide-react";
import { WalletDrawer } from "@/components/wallet/wallet-drawer";
import type { AppAuth } from "@/components/app-providers";
import { ThemeToggle } from "@/components/theme-toggle";
import { DEMO_PROGRAM_ID } from "@/lib/demo-config";
import { useAccountSummary } from "@/features/portfolio/use-account-summary";
import { formatUsdUnits, Skeleton } from "@/components/ui/primitives";

const LOW_SOL_LAMPORTS = 10_000_000n;

const OPEN_WALLET_EVENT = "equinox:open-wallet";
/** Opens the wallet drawer from anywhere (e.g. "Sign in to trade"). */
export function openWalletDrawer() {
  window.dispatchEvent(new Event(OPEN_WALLET_EVENT));
}

export type ActiveSection = "trade" | "launch" | "pre-ipo" | "portfolio" | "activity" | "settings" | "diagnostics";

type AuthDisplayBranch = "signed_in" | "choose_wallet" | "signed_out";

function branchFor(auth: AppAuth): AuthDisplayBranch {
  if (auth.walletAddress) return "signed_in";
  if (auth.wallets.length > 0) return "choose_wallet";
  return "signed_out";
}

const NAV = [
  { id: "trade", href: "/trade", label: "Trade" },
  { id: "launch", href: "/launch", label: "Launch" },
  { id: "pre-ipo", href: "/pre-ipo", label: "Pre-IPO" },
] as const satisfies readonly { id: ActiveSection; href: string; label: string }[];

/** Account pages live behind the wallet pill (drawer tabs) rather than the
 * main nav; the mobile menu lists them too. */
const ACCOUNT_NAV = [
  { id: "portfolio", href: "/portfolio", label: "Portfolio" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "settings", href: "/settings", label: "Settings" },
] as const satisfies readonly { id: ActiveSection; href: string; label: string }[];
const ACCOUNT_SECTIONS: readonly ActiveSection[] = ["portfolio", "activity", "settings", "diagnostics"];

const ICON_LINK = "hidden h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] transition-colors hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] sm:inline-flex";

/** Terminal top bar (SlipStream TerminalNav): identity and sections on the
 * left; utilities, theme and wallet on the right. */
export function TopBar({ active, auth }: { active: ActiveSection; auth: AppAuth }) {
  // Sign in / Choose wallet / address+Log out are mutually exclusive: activating
  // one unmounts it. Move focus to whichever replaces it so keyboard users are
  // never stranded on <body> (tests/browser/keyboard-only.spec.ts).
  const primaryActionRef = useRef<HTMLElement | null>(null);
  const setPrimaryActionRef = (el: HTMLElement | null) => { primaryActionRef.current = el; };
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const summary = useAccountSummary(auth.walletAddress);
  const accountActive = ACCOUNT_SECTIONS.includes(active);
  const closeDrawer = useCallback(() => { setDrawer(false); primaryActionRef.current?.focus(); }, []);
  useEffect(() => {
    const open = () => setDrawer(true);
    window.addEventListener(OPEN_WALLET_EVENT, open);
    return () => window.removeEventListener(OPEN_WALLET_EVENT, open);
  }, []);
  const walletIcon = auth.walletOptions.find((option) => option.name.toLowerCase() === auth.walletClientType)?.icon;
  const branch = branchFor(auth);
  const previousBranchRef = useRef(branch);
  useEffect(() => {
    if (previousBranchRef.current !== branch) primaryActionRef.current?.focus();
    previousBranchRef.current = branch;
  }, [branch]);

  return (
    <header className="relative flex h-[60px] shrink-0 items-center border-b border-[var(--t-border)] bg-[var(--t-bg)] px-4 sm:h-[68px] sm:px-6">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Equinox home">
        <img src="/favicon.svg" alt="" className="h-7 w-7 rounded sm:h-8 sm:w-8" />
        <span className="text-[19px] font-semibold tracking-[-0.035em] text-[var(--t-text)] sm:text-[25px]">Equinox</span>
      </Link>
      <span className="ml-3 hidden rounded bg-[var(--t-surface-3)] px-2 py-0.5 text-[10px] font-medium text-[var(--t-text-2)] xl:inline">Devnet</span>

      <nav aria-label="Primary navigation" className="ml-8 hidden h-full min-w-0 items-stretch gap-6 md:flex">
        {NAV.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active === item.id ? "page" : undefined}
            className={`relative flex items-center text-[14px] font-medium transition-colors ${
              active === item.id
                ? "text-[var(--t-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-[var(--t-text)]"
                : "text-[var(--t-text-2)] hover:text-[var(--t-text)]"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <a href={`https://explorer.solana.com/address/${DEMO_PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={ICON_LINK} aria-label="Program on Solana Explorer" title="Program on Explorer">
          <Compass className="h-4 w-4" strokeWidth={1.75} />
        </a>
        <a href="https://www.magicblock.gg/" target="_blank" rel="noopener noreferrer" className={ICON_LINK} aria-label="MagicBlock" title="MagicBlock">
          <Zap className="h-4 w-4" strokeWidth={1.75} />
        </a>
        <Link href="/settings" className={`${ICON_LINK} ${active === "settings" ? "bg-[var(--t-surface-3)] text-[var(--t-text)]" : ""}`} aria-label="Settings" title="Settings" aria-current={active === "settings" ? "page" : undefined}>
          <Settings className="h-4 w-4" strokeWidth={1.75} />
        </Link>
        <ThemeToggle />
        <div className="ml-2 flex items-center gap-2">
          {auth.walletAddress ? (
            <button
              ref={setPrimaryActionRef}
              className={`wallet-button wallet-chip topbar-wallet account-pill ${accountActive ? "account-pill-active" : ""}`}
              onClick={() => setDrawer(true)}
              aria-label={`Account ${auth.walletAddress.slice(0, 4)}...${auth.walletAddress.slice(-4)}, balance ${summary.totalUsdc === null ? "loading" : formatUsdUnits(summary.totalUsdc)}`}
            >
              {walletIcon ? <img src={walletIcon} alt="" className="h-[18px] w-[18px] rounded-[5px]" /> : <WalletCards size={15} />}
              <span className="tnum flex items-center gap-1.5 font-semibold">
                {summary.totalUsdc === null ? <Skeleton className="h-[14px] w-14" /> : formatUsdUnits(summary.totalUsdc)}
                {summary.wallet?.sol !== null && summary.wallet?.sol !== undefined ? (
                  <span className="hidden items-center gap-1 text-[11.5px] font-normal text-[var(--t-text-2)] lg:inline-flex">
                    · {(Number(summary.wallet.sol) / 1e9).toFixed(3)} SOL
                    {summary.wallet.sol < LOW_SOL_LAMPORTS ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--t-warn)]" title="Low SOL for network fees" /> : null}
                  </span>
                ) : null}
              </span>
              <span className="account-pill-divider hidden h-4 w-px bg-[var(--t-border-strong)] sm:block" aria-hidden />
              <span className="hidden font-mono text-[12px] text-[var(--t-text-2)] sm:inline">{auth.walletAddress.slice(0, 4)}...{auth.walletAddress.slice(-4)}</span>
              <ChevronDown size={14} className="opacity-60" />
            </button>
          ) : (
            <button ref={setPrimaryActionRef} className="wallet-button topbar-wallet" onClick={() => setDrawer(true)}>
              <WalletCards size={15} />
              {auth.wallets.length > 1 ? `Choose wallet (${auth.wallets.length})` : auth.wallets.length === 1 ? "Finish sign-in" : "Connect wallet"}
            </button>
          )}
          <button type="button" onClick={() => setMenu((open) => !open)} aria-expanded={menu} aria-controls="mobile-nav" aria-label={menu ? "Close menu" : "Open menu"}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)] md:hidden">
            {menu ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {menu ? (
        <nav id="mobile-nav" aria-label="Mobile navigation" className="absolute inset-x-0 top-full z-40 border-b border-[var(--t-border)] bg-[var(--t-bg)] px-4 py-3 shadow-lg md:hidden">
          <ul className="grid grid-cols-2 gap-1">
            {[...NAV, ...ACCOUNT_NAV].map((item) => (
              <li key={item.id}>
                <Link href={item.href} onClick={() => setMenu(false)} aria-current={active === item.id ? "page" : undefined}
                  className={`block rounded-[8px] px-3 py-2.5 text-[14px] font-medium ${active === item.id ? "bg-[var(--t-surface-3)] text-[var(--t-text)]" : "text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)]"}`}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    <WalletDrawer auth={auth} open={drawer} onClose={closeDrawer} summary={summary} />
    </header>
  );
}
